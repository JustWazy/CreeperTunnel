#!/usr/bin/env node

const dgram = require('dgram');
const zlib = require('zlib');

const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '21115', 10);
const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';
const AUTH_KEY = process.env.AUTH_KEY || 'changeme';
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || '60000', 10);
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || '30000', 10);
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

const COMPRESSION_MIN_SIZE = parseInt(process.env.COMPRESSION_MIN_SIZE || '0', 10);

const SOCKET_RECV_BUFFER = parseInt(process.env.SOCKET_RECV_BUFFER || '1048576', 10);
const SOCKET_SEND_BUFFER = parseInt(process.env.SOCKET_SEND_BUFFER || '1048576', 10);

function dbg(...args) {
    if (DEBUG) console.log('[debug]', ...args);
}

function hexPreview(buf, n = 64) {
    const slice = buf.slice(0, n);
    const hex = slice.toString('hex').match(/.{1,2}/g)?.join(' ') || '';
    const ascii = [...slice].map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
    return `hex[${hex}] ascii[${ascii}]${buf.length > n ? ` (+${buf.length - n} more bytes)` : ''}`;
}

function rewritePongPorts(payload, externalPort) {
    if (payload.length < 35 || payload[0] !== 0x1c) return payload;
    const strLen = payload.readUInt16BE(33);
    if (35 + strLen > payload.length) return payload;

    const header = payload.slice(0, 33);
    const motd = payload.slice(35, 35 + strLen).toString('utf8');
    const rest = payload.slice(35 + strLen);

    const fields = motd.split(';');
    if (fields.length < 11) return payload;

    const before = motd;
    fields[10] = String(externalPort);
    if (fields.length > 11) fields[11] = String(externalPort);
    const newMotd = fields.join(';');

    if (newMotd === before) return payload;

    const newMotdBuf = Buffer.from(newMotd, 'utf8');
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(newMotdBuf.length, 0);
    dbg(`rewrote pong ports -> ${externalPort} (was: "${before}", now: "${newMotd}")`);
    return Buffer.concat([header, lenBuf, newMotdBuf, rest]);
}

const stats = {
    clientPacketsIn: 0,
    clientBytesIn: 0,
    toAgentSent: 0,
    toAgentErrors: 0,
    fromAgentDataIn: 0,
    toClientSent: 0,
    toClientErrors: 0,
    sessionMisses: 0,
    droppedNoAgent: 0,
};

const MAGIC = Buffer.from([0xF7, 0x3A, 0x9C, 0x02, 0xE1, 0x5B, 0x88, 0x40]);
const TYPE_HELLO = 0x01;
const TYPE_HELLO_ACK = 0x02;
const TYPE_DATA_TO_AGENT = 0x03;
const TYPE_DATA_TO_RELAY = 0x04;
const TYPE_PING = 0x05;
const TYPE_PONG = 0x06;
const TYPE_DATA_TO_AGENT_Z = 0x07;
const TYPE_DATA_TO_RELAY_Z = 0x08;

function encodeDataFrame(baseType, compressedType, sessionId, payload) {
    let body = payload;
    let type = baseType;
    if (COMPRESSION_MIN_SIZE > 0 && payload.length >= COMPRESSION_MIN_SIZE) {
        try {
            const compressed = zlib.deflateRawSync(payload);
            if (compressed.length < payload.length) {
                body = compressed;
                type = compressedType;
            }
        } catch (err) {
            dbg('compression failed, sending raw:', err.message);
        }
    }
    const header = Buffer.alloc(3);
    header[0] = type;
    header.writeUInt16BE(sessionId & 0xffff, 1);
    return Buffer.concat([header, body]);
}

function decodeDataFrame(msg) {
    const type = msg[0];
    const sessionId = msg.readUInt16BE(1);
    let payload = msg.slice(3);
    if (type === TYPE_DATA_TO_AGENT_Z || type === TYPE_DATA_TO_RELAY_Z) {
        payload = zlib.inflateRawSync(payload);
    }
    return {
        sessionId,
        payload
    };
}

const socket = dgram.createSocket('udp4');

let agent = null;
let nextSessionId = 1;
const sessionsById = new Map();
const sessionsByKey = new Map();

function isAgent(rinfo) {
    return agent && rinfo.address === agent.address && rinfo.port === agent.port;
}

function getOrCreateSession(rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    let id = sessionsByKey.get(key);
    if (id === undefined) {
        id = nextSessionId++;
        if (nextSessionId > 0xffff) nextSessionId = 1;
        sessionsByKey.set(key, id);
        sessionsById.set(id, {
            address: rinfo.address,
            port: rinfo.port,
            lastActive: Date.now()
        });
        console.log(`[+] client session ${id} <- ${key} (${sessionsById.size} active)`);
    } else {
        sessionsById.get(id).lastActive = Date.now();
    }
    return id;
}

socket.on('message', (msg, rinfo) => {
    if (
        msg.length > MAGIC.length &&
        msg.slice(0, MAGIC.length).equals(MAGIC) &&
        msg[MAGIC.length] === TYPE_HELLO
    ) {
        const key = msg.slice(MAGIC.length + 1).toString('utf8');
        if (key === AUTH_KEY) {
            agent = {
                address: rinfo.address,
                port: rinfo.port,
                lastSeen: Date.now()
            };
            socket.send(Buffer.concat([MAGIC, Buffer.from([TYPE_HELLO_ACK])]), rinfo.port, rinfo.address);
            console.log(`[agent] registered from ${rinfo.address}:${rinfo.port}`);
        } else {
            console.warn(`[agent] rejected HELLO from ${rinfo.address}:${rinfo.port} (bad key)`);
        }
        return;
    }

    if (isAgent(rinfo)) {
        agent.lastSeen = Date.now();

        if (msg[0] === TYPE_PING) {
            dbg(`PING from agent ${rinfo.address}:${rinfo.port}`);
            socket.send(Buffer.from([TYPE_PONG]), rinfo.port, rinfo.address);
            return;
        }

        if (msg[0] === TYPE_DATA_TO_RELAY || msg[0] === TYPE_DATA_TO_RELAY_Z) {
            stats.fromAgentDataIn++;
            const {
                sessionId: id,
                payload: rawPayload
            } = decodeDataFrame(msg);
            const payload = rewritePongPorts(rawPayload, LISTEN_PORT);
            const session = sessionsById.get(id);
            if (session) {
                dbg(`agent->client: session ${id} -> ${session.address}:${session.port}, ${payload.length} bytes`);
                if (DEBUG && payload.length > 35 && payload[0] === 0x1c) {
                    const strLen = payload.readUInt16BE(33);
                    const motd = payload.slice(35, 35 + strLen).toString('utf8');
                    dbg(`  decoded MOTD (${strLen} bytes): ${motd}`);
                }
                socket.send(payload, session.port, session.address, (err) => {
                    if (err) {
                        stats.toClientErrors++;
                        console.error(`[relay->client] send error (session ${id}):`, err.message);
                    } else {
                        stats.toClientSent++;
                    }
                });
                session.lastActive = Date.now();
            } else {
                stats.sessionMisses++;
                console.warn(`[relay->client] got reply for unknown session ${id} (already expired? client reconnected?)`);
            }
            return;
        }

        dbg(`unknown frame type 0x${msg[0]?.toString(16)} from agent, ${msg.length} bytes, ignoring`);
        return;
    }

    stats.clientPacketsIn++;
    stats.clientBytesIn += msg.length;

    if (!agent) {
        stats.droppedNoAgent++;
        console.warn(`[client->agent] DROPPED packet from ${rinfo.address}:${rinfo.port} — no agent registered yet`);
        return;
    }

    const id = getOrCreateSession(rinfo);
    dbg(`client->agent: session ${id} from ${rinfo.address}:${rinfo.port}, ${msg.length} bytes`);
    dbg(`  ping payload: ${hexPreview(msg)}`);
    const frame = encodeDataFrame(TYPE_DATA_TO_AGENT, TYPE_DATA_TO_AGENT_Z, id, msg);
    socket.send(frame, agent.port, agent.address, (err) => {
        if (err) {
            stats.toAgentErrors++;
            console.error(`[client->agent] send error (session ${id}):`, err.message);
        } else {
            stats.toAgentSent++;
        }
    });
});

socket.on('error', (err) => {
    console.error('[relay] socket error:', err.stack);
    socket.close();
});

socket.on('listening', () => {
    const addr = socket.address();
    console.log(`Relay listening on ${addr.address}:${addr.port} (public/client side)`);
    console.log('Waiting for tunnel agent to register...');
    try {
        socket.setRecvBufferSize(SOCKET_RECV_BUFFER);
        socket.setSendBufferSize(SOCKET_SEND_BUFFER);
        dbg(`socket buffers: recv=${socket.getRecvBufferSize()} send=${socket.getSendBufferSize()}`);
    } catch (err) {
        console.warn('[relay] could not resize socket buffers:', err.message);
    }
});

socket.bind(LISTEN_PORT, LISTEN_HOST);

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessionsById) {
        if (now - session.lastActive > SESSION_TIMEOUT_MS) {
            sessionsById.delete(id);
            sessionsByKey.delete(`${session.address}:${session.port}`);
            console.log(`[-] client session ${id} expired (${sessionsById.size} active)`);
        }
    }
    if (agent && now - agent.lastSeen > AGENT_TIMEOUT_MS) {
        console.warn('[agent] timed out, clearing registration');
        agent = null;
    }
}, 10000).unref();

setInterval(() => {
    console.log(
        `[stats] agent=${agent ? `${agent.address}:${agent.port}` : 'none'} ` +
        `sessions=${sessionsById.size} ` +
        `clientIn=${stats.clientPacketsIn}(${stats.clientBytesIn}B) ` +
        `toAgent=${stats.toAgentSent}/${stats.toAgentSent + stats.toAgentErrors} ` +
        `fromAgent=${stats.fromAgentDataIn} ` +
        `toClient=${stats.toClientSent}/${stats.toClientSent + stats.toClientErrors} ` +
        `sessionMisses=${stats.sessionMisses} droppedNoAgent=${stats.droppedNoAgent}`
    );
}, 15000).unref();

process.on('SIGINT', () => {
    console.log('\nShutting down relay...');
    socket.close(() => process.exit(0));
});
