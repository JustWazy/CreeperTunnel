# Minecraft Bedrock UDP Tunnel

Tunnel UDP sederhana untuk **Minecraft Bedrock Dedicated Server** yang memungkinkan server berjalan di jaringan lokal (NAT/private network) tanpa perlu port forwarding.

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

# Instalasi

## 1. Clone Repository

```bash
git clone https://github.com/JustWazy/CreeperTunnel.git
```

Masuk ke folder project.

```bash
cd CreeperTunnel
```

Install dependency.

```bash
npm install
```

---

# Menjalankan Relay

```bash
AUTH_KEY=rahasia \
LISTEN_PORT=21115 \
node relay-server.js
```

---

# Menjalankan Agent

```bash
RELAY_HOST=IP_RELAY \
RELAY_PORT=21115 \
TARGET_HOST=127.0.0.1 \
TARGET_PORT=19132 \
AUTH_KEY=rahasia \
node agent-target.js
```

---

# Mengganti Port

## Mengubah port Relay

Misalnya ingin menggunakan port **30000**.

### Relay

```bash
AUTH_KEY=rahasia \
LISTEN_PORT=30000 \
node relay-server.js
```

### Agent

```bash
RELAY_HOST=IP_RELAY \
RELAY_PORT=30000 \
TARGET_HOST=127.0.0.1 \
TARGET_PORT=19132 \
AUTH_KEY=rahasia \
node agent-target.js
```

Player nantinya cukup masuk ke:

```
IP_RELAY:30000
```

---

## Mengubah port Minecraft

Jika Bedrock Dedicated Server berjalan di port selain **19132**, cukup ubah:

```bash
TARGET_PORT=25000
```

Tidak perlu mengubah konfigurasi lainnya.

---

# Konfigurasi

## Relay

| Variable | Fungsi |
|----------|---------|
| LISTEN_PORT | Port publik Relay |
| LISTEN_HOST | Interface bind (`0.0.0.0`) |
| AUTH_KEY | Password antara Relay dan Agent |

## Agent

| Variable | Fungsi |
|----------|---------|
| RELAY_HOST | IP atau Domain Relay |
| RELAY_PORT | Port Relay |
| LOCAL_PORT | Port lokal Agent (bebas, tidak harus sama dengan Relay) |
| TARGET_HOST | IP Minecraft Server |
| TARGET_PORT | Port Minecraft Server |
| AUTH_KEY | Harus sama dengan Relay |
---

# Keamanan

Relay hanya menerima agent yang berhasil melakukan autentikasi menggunakan `AUTH_KEY`.

Pastikan menggunakan `AUTH_KEY` yang kuat dan tidak dibagikan kepada pihak lain.

---

# Lisensi

MIT License
