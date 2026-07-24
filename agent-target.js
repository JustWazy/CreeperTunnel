#!/usr/bin/env node

const dgram = require('dgram');
const zlib = require('zlib');

const RELAY_HOST = process.env.RELAY_HOST || '127.0.0.1';
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '21115', 10);
const LOCAL_PORT = parseInt(process.env.LOCAL_PORT || '21116', 10);
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '19132', 10);
const AUTH_KEY = process.env.AUTH_KEY || 'changeme';
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || '60000', 10);
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS || '15000', 10);
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

const COMPRESSION_MIN_SIZE = parseInt(process.env.COMPRESSION_MIN_SIZE || '0', 10);

const SOCKET_RECV_BUFFER = parseInt(process.env.SOCKET_RECV_BUFFER || '1048576', 10);
const SOCKET_SEND_BUFFER = parseInt(process.env.SOCKET_SEND_BUFFER || '1048576', 10);

function dbg(...args) {
    if (DEBUG) console.log('[debug]', ...args);
}

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

const mainSocket = dgram.createSocket('udp4');
let registered = false;

const sessions = new Map();

function sendHello() {
    const frame = Buffer.concat([MAGIC, Buffer.from([TYPE_HELLO]), Buffer.from(AUTH_KEY, 'utf8')]);
    mainSocket.send(frame, RELAY_PORT, RELAY_HOST);
}

function getOrCreateSession(id) {
    let session = sessions.get(id);
    if (session) return session;

    const localSocket = dgram.createSocket('udp4');

    localSocket.on('message', (reply) => {
        const frame = encodeDataFrame(TYPE_DATA_TO_RELAY, TYPE_DATA_TO_RELAY_Z, id, reply);
        mainSocket.send(frame, RELAY_PORT, RELAY_HOST);
        const s = sessions.get(id);
        if (s) s.lastActive = Date.now();
    });

    localSocket.on('error', (err) => {
        console.error(`[session ${id}] local socket error:`, err.message);
        closeSession(id);
    });

    session = {
        socket: localSocket,
        lastActive: Date.now()
    };
    sessions.set(id, session);
    console.log(`[+] session ${id} opened (${sessions.size} active)`);
    return session;
}

function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    try {
        session.socket.close();
    } catch (_) {}
    sessions.delete(id);
    console.log(`[-] session ${id} closed (${sessions.size} active)`);
}

mainSocket.on('message', (msg, rinfo) => {
    if (rinfo.address !== RELAY_HOST || rinfo.port !== RELAY_PORT) return;

    if (
        msg.length > MAGIC.length &&
        msg.slice(0, MAGIC.length).equals(MAGIC) &&
        msg[MAGIC.length] === TYPE_HELLO_ACK
    ) {
        if (!registered) console.log('[agent] registered with relay');
        registered = true;
        return;
    }

    if (msg[0] === TYPE_PONG) return;

    if (msg[0] === TYPE_DATA_TO_AGENT || msg[0] === TYPE_DATA_TO_AGENT_Z) {
        const {
            sessionId: id,
            payload
        } = decodeDataFrame(msg);
        const session = getOrCreateSession(id);
        session.lastActive = Date.now();
        session.socket.send(payload, TARGET_PORT, TARGET_HOST, (err) => {
            if (err) console.error(`[agent->target] send error (session ${id}):`, err.message);
        });
    }
});

mainSocket.on('error', (err) => {
    console.error('[agent] main socket error:', err.stack);
    mainSocket.close();
});

mainSocket.on('listening', () => {
    const addr = mainSocket.address();
    console.log(`Agent bound locally on ${addr.address}:${addr.port}`);
    console.log(`Connecting to relay at ${RELAY_HOST}:${RELAY_PORT} ...`);
    try {
        mainSocket.setRecvBufferSize(SOCKET_RECV_BUFFER);
        mainSocket.setSendBufferSize(SOCKET_SEND_BUFFER);
        dbg(`socket buffers: recv=${mainSocket.getRecvBufferSize()} send=${mainSocket.getSendBufferSize()}`);
    } catch (err) {
        console.warn('[agent] could not resize socket buffers:', err.message);
    }
    sendHello();
});

mainSocket.bind(LOCAL_PORT);

setInterval(() => {
    if (!registered) {
        sendHello();
    } else {
        mainSocket.send(Buffer.from([TYPE_PING]), RELAY_PORT, RELAY_HOST);
    }
}, PING_INTERVAL_MS).unref();

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastActive > SESSION_TIMEOUT_MS) {
            closeSession(id);
        }
    }
}, 10000).unref();

process.on('SIGINT', () => {
    console.log('\nShutting down agent...');
    for (const id of sessions.keys()) closeSession(id);
    mainSocket.close(() => process.exit(0));
});
