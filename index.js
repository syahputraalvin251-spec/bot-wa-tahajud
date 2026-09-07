const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

const TARGET_GROUP_ID = '120363429342229342@g.us'; 
const TIMEZONE = 'Asia/Jakarta';
const SPREADSHEET_ID = 'MASUKKAN_ID_SPREADSHEET_ANDA_DISINI'; 

let dailyVotes = {};
let absenActive = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Dimatikan agar kita bisa cetak QR kustom yang lebih rapi
        logger: pino({ level: 'silent' }),
        browser: ['Bot Tahajud', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n==================================================');
            qrcode.generate(qr, { small: true });
            console.log('^ SILAKAN SCAN QR CODE DI ATAS MENGGUNAKAN HP ANDA ^');
            console.log('==================================================\n');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Mencoba menghubungkan ulang...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp berhasil terhubung dan siap digunakan!');
            scheduleJobs(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const groupId = msg.key.remoteJid;

        if (text === '!cekid') {
            await sock.sendMessage(groupId, { text: `ID Grup ini adalah: ${groupId}` });
            return;
        }

        if (groupId === TARGET_GROUP_ID && absenActive) {
            const lowerText = text.toLowerCase().trim();
            if (lowerText === '1' || lowerText === '#absen tahajud') {
                dailyVotes[sender] = 'Hadir';
                console.log(`Berhasil mencatat absen dari: ${sender}`);
            }
        }
    });
}

async function saveToGoogleSheets(data) {
    try {
        if (!fs.existsSync('./credentials.json')) return;
        const creds = require('./credentials.json');
        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
        await doc.loadInfo(); 
        const sheet = doc.sheetsByIndex[0]; 
        let rows = [];
        const dateStr = new Date().toLocaleDateString('id-ID', { timeZone: TIMEZONE });
        for (const [sender, status] of Object.entries(data)) {
            rows.push({ 'Tanggal': dateStr, 'Nomor': sender.split('@')[0], 'Status': status });
        }
        if (rows.length > 0) await sheet.addRows(rows);
        console.log('Data absen berhasil disimpan ke Google Sheets.');
    } catch (error) { console.error("Gagal menyimpan ke Sheets:", error); }
}

function scheduleJobs(sock) {
    cron.schedule('0 3 * * *', async () => {
        absenActive = true;
        dailyVotes = {}; 
        await sock.sendMessage(TARGET_GROUP_ID, { text: `*PENGINGAT TAHAJUD*\n\nMari kita bangun untuk melaksanakan Sholat Tahajud.\n\nSilakan absen dengan membalas pesan ini mengetik angka *1* atau *#absen tahajud*.` });
    }, { timezone: TIMEZONE });

    cron.schedule('0 6 * * *', async () => {
        absenActive = false; 
        let rekapPesan = `*REKAP ABSEN TAHAJUD*\nTanggal: ${new Date().toLocaleDateString('id-ID', { timeZone: TIMEZONE })}\n\n`;
        let count = 1;
        for (const [sender, status] of Object.entries(dailyVotes)) {
            rekapPesan += `${count}. @${sender.split('@')[0]}\n`;
            count++;
        }
        if (Object.keys(dailyVotes).length === 0) {
            rekapPesan += 'Belum ada yang absen hari ini.';
        }
        await sock.sendMessage(TARGET_GROUP_ID, { text: rekapPesan, mentions: Object.keys(dailyVotes) });
        await saveToGoogleSheets(dailyVotes);
    }, { timezone: TIMEZONE });
}

connectToWhatsApp();
