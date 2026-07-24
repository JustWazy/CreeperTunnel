# Minecraft Bedrock UDP Tunnel

Tunnel UDP sederhana untuk **Minecraft Bedrock Dedicated Server** yang memungkinkan server berjalan di jaringan lokal (NAT/private network) tanpa perlu port forwarding.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![Platform](https://img.shields.io/badge/platform-Termux%20%7C%20Node.js-orange)

Dirancang untuk kebutuhan **self-hosting**, terutama ketika server dijalankan dari perangkat Android menggunakan Winlator.

> Source:
> - `relay-server.js` :contentReference[oaicite:0]{index=0}
> - `agent-target.js` :contentReference[oaicite:1]{index=1}

---

## Arsitektur

```
Internet
    │
    │ UDP PORT
    ▼
┌──────────────────────────────┐
│ Relay                        │
│ Hosting Node.js Gratis       │
│ (1 Port UDP Terbuka)         │
└──────────────┬───────────────┘
               │
               │ Tunnel UDP
               ▼
┌──────────────────────────────┐
│ Android / Termux             │
│ agent-target.js              │
└──────────────┬───────────────┘
               │ localhost UDP
               ▼
┌──────────────────────────────┐
│ Winlator                     │
│ Minecraft Bedrock Dedicated  │
│ Server                       │
└──────────────────────────────┘
```

---

# Cara Kerja

Konsep tunnel ini menggunakan dua komponen:

## Relay

Relay dijalankan pada hosting Node.js yang memiliki **1 port UDP publik**.

Fungsi relay:

- menerima koneksi pemain
- menerima koneksi dari agent
- membuat session untuk setiap pemain
- meneruskan paket UDP ke agent
- mengirim balasan dari server kembali ke pemain

Relay **tidak menjalankan Minecraft**, hanya meneruskan paket.

---

## Agent

Agent dijalankan di **Termux**.

Agent melakukan koneksi keluar (outbound) menuju relay sehingga:

- tidak membutuhkan port forwarding
- dapat berjalan di jaringan NAT
- dapat menggunakan hotspot, WiFi rumah, VPS, dll

Agent akan:

1. register ke relay menggunakan `AUTH_KEY`
2. menerima paket dari relay
3. mengirim paket tersebut ke Bedrock Dedicated Server
4. menerima balasan server
5. mengirim balasan kembali ke relay

---

## Minecraft Server

Minecraft Bedrock Dedicated Server berjalan di **Winlator**.

Server tetap berjalan seperti biasa pada:

```
127.0.0.1:19132
```

Agent akan meneruskan seluruh paket UDP menuju server tersebut.

Minecraft tidak mengetahui bahwa koneksi berasal dari tunnel.

---

# Kelebihan

- Tidak memerlukan port forwarding
- Cocok untuk CGNAT
- Hanya membutuhkan 1 port UDP publik
- Dapat dijalankan di hosting Node.js
- Mendukung banyak pemain sekaligus
- Session setiap pemain dipisahkan secara otomatis
- Tidak mengubah protocol Minecraft

---

# Topologi Self Hosting

Contoh penggunaan:

```
Hosting Gratis
└── relay-server.js

Android
├── Termux
│   └── agent-target.js
│
└── Winlator
    └── Minecraft Bedrock Dedicated Server
```

Alur paket:

```
Player
    │
    ▼
Relay
    │
    ▼
Agent (Termux)
    │
    ▼
Minecraft Bedrock Server (Winlator)
    │
    ▲
    └──────── kembali melalui tunnel
```
# Setup
## Instalasi Relay

1. Download relay files
2. Install module zlib & dgram
3. Upload ke hosting nodejs gratis
4. Sesuaikan konfigurasi port pada script dengan port yang dibuka oleh hosting

## Instalasi Agent
Paste di termux lalu setelahnya sesuaikan konfigurasi port dengan relay dan port yang menjalankan minecraft servr
```bash
git clone https://github.com/JustWazy/CreeperTunnel.git
cd CreeperTunnel
npm install dgram zlib
node agent-target.js
```

