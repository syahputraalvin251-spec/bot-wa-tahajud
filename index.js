const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, getAggregateVotesInPollMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const cron = require('node-cron');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const readline = require('readline');

// ======= KONFIGURASI PENTING =======
const NOMOR_HP_BOT = '6285137619957'; 
const TARGET_GROUP_ID = '120363429342229342@g.us'; 
const TIMEZONE = 'Asia/Jakarta';
const SPREADSHEET_ID = '11oqVmxfVwySlBiNI6jD8NfSkdBniTwSzI-2Bgg9wNKY'; 
// ===================================

let isRequestingCode = false; 

// Menggunakan Volume auth_info_baileys agar data vote tidak hilang saat server restart
const POLL_DATA_PATH = './auth_info_baileys/poll_data.json';
const VOTES_DATA_PATH = './auth_info_baileys/rekap_votes.json';
const NAMES_DATA_PATH = './auth_info_baileys/names_registry.json';

function getPollData() {
    if (fs.existsSync(POLL_DATA_PATH)) return JSON.parse(fs.readFileSync(POLL_DATA_PATH));
    return { pollCreation: null, updates: [] };
}
function savePollData(data) { fs.writeFileSync(POLL_DATA_PATH, JSON.stringify(data)); }

function getVotesData() {
    if (fs.existsSync(VOTES_DATA_PATH)) return JSON.parse(fs.readFileSync(VOTES_DATA_PATH));
    return {};
}
function saveVotesData(data) { fs.writeFileSync(VOTES_DATA_PATH, JSON.stringify(data)); }

function getNameRegistry() {
    if (fs.existsSync(NAMES_DATA_PATH)) return JSON.parse(fs.readFileSync(NAMES_DATA_PATH));
    return {};
}
function saveNameRegistry(data) { fs.writeFileSync(NAMES_DATA_PATH, JSON.stringify(data)); }


async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Windows', 'Chrome', '1.0.0']
    });

    if (!sock.authState.creds.registered && !isRequestingCode) {
        isRequestingCode = true; 
        console.log('Menunggu 10 detik agar server stabil sebelum meminta kode...');
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(NOMOR_HP_BOT);
                console.log('\n==================================================');
                console.log('🎉 KODE TAUTAN ANDA:', code);
                console.log('^ MASUKKAN KODE DI ATAS KE MENU "TAUTKAN PERANGKAT" DI WA HP ANDA ^');
                console.log('==================================================\n');
                
                console.log('Menunggu 60 detik agar Anda santai memasukkan kode di HP...');
                setTimeout(() => { isRequestingCode = false; }, 60000);
            } catch (error) {
                console.error('Gagal meminta kode tautan:', error.message);
                isRequestingCode = false;
            }
        }, 10000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Mencoba menghubungkan ulang...', shouldReconnect);
            if (shouldReconnect) setTimeout(connectToWhatsApp, 15000); 
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
        const pushName = msg.pushName || 'Hamba Allah';

        // Simpan nama pengguna agar rekapnya menampilkan nama asli (jika tersedia)
        if (pushName !== 'Hamba Allah') {
            const names = getNameRegistry();
            names[sender] = pushName;
            saveNameRegistry(names);
        }

        // Cek apakah pesan ini adalah perintah cek ID
        if (msg.message.conversation === '!cekid' || msg.message.extendedTextMessage?.text === '!cekid') {
            await sock.sendMessage(msg.key.remoteJid, { text: `ID Grup ini adalah: ${msg.key.remoteJid}` });
            return;
        }

        // Tangkap Update Polling WA Asli
        if (msg.message.pollUpdateMessage) {
            const pollData = getPollData();
            
            // Verifikasi apakah update ini berasal dari polling tahajud kita
            if (pollData.pollCreation && msg.message.pollUpdateMessage.pollCreationMessageKey.id === pollData.pollCreation.key.id) {
                
                // Simpan update ke memori agar bisa didekripsi
                pollData.updates.push(msg); 
                savePollData(pollData);

                // Dekripsi hasil vote menggunakan fungsi bawaan Baileys
                const aggregated = getAggregateVotesInPollMessage({
                    message: pollData.pollCreation.message,
                    pollUpdates: pollData.updates
                });

                // Rekonstruksi ulang data vote harian
                const names = getNameRegistry();
                let newVotes = {};
                
                aggregated.forEach(option => {
                    option.voters.forEach(voterJid => {
                        newVotes[voterJid] = {
                            name: names[voterJid] || 'Hamba Allah',
                            pilihan: option.name // 'Tahajud' atau 'Qiyamul Lail'
                        };
                    });
                });
                
                saveVotesData(newVotes);
                console.log(`Berhasil merekam pilihan polling terbaru!`);
            }
        }
    });
}

async function saveToGoogleSheets(data) {
    try {
        if (!fs.existsSync('./credentials.json')) {
            console.log("File credentials.json tidak ditemukan.");
            return;
        }
        
        const creds = require('./credentials.json');
        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
        await doc.loadInfo(); 
        
        const sheetHarian = doc.sheetsByIndex[0]; // Tab 1
        const sheetBulanan = doc.sheetsByIndex[1]; // Tab 2
        
        let rows = [];
        
        // Ambil waktu spesifik zona Jakarta
        const now = new Date(new Date().toLocaleString("en-US", {timeZone: TIMEZONE}));
        const tanggalStr = now.toLocaleDateString('id-ID', { day: '2-digit' });
        const bulanStr = now.toLocaleDateString('id-ID', { month: 'long' });

        for (const [jid, info] of Object.entries(data)) {
            rows.push({ 
                'Tanggal': tanggalStr, 
                'Bulan': bulanStr,
                'Nama': info.name,
                'Nomor WA': jid.split('@')[0], 
                'Pilihan': info.pilihan 
            });
        }
        
        if (rows.length > 0) {
            // Simpan ke Sheet Harian
            if (sheetHarian) await sheetHarian.addRows(rows);
            // Simpan ke Sheet Bulanan
            if (sheetBulanan) await sheetBulanan.addRows(rows);
            
            console.log(`Berhasil menyimpan ${rows.length} data ke Sheets Harian & Bulanan.`);
        }
    } catch (error) { 
        console.error("Gagal menyimpan ke Sheets:", error); 
    }
}

function scheduleJobs(sock) {
    // 1. Pukul 21.00 WIB: Kirim Polling
    cron.schedule('0 21 * * *', async () => {
        // Bersihkan data polling & rekap hari sebelumnya
        savePollData({ pollCreation: null, updates: [] });
        saveVotesData({}); 
        
        const pollMessage = {
            name: 'Malam ini mau melaksanakan shalat apa nih?',
            values: ['Tahajud', 'Qiyamul Lail'],
            selectableCount: 1 // Orang hanya bisa memilih salah satu
        };
        
        // Kirim Polling Asli WA
        const sentMsg = await sock.sendMessage(TARGET_GROUP_ID, { poll: pollMessage });
        
        // Simpan data pesan polling sebagai kunci dekripsi
        savePollData({ pollCreation: sentMsg, updates: [] });
        console.log('Polling malam berhasil dikirim.');

    }, { timezone: TIMEZONE });

    // 2. Pukul 03.00 WIB: Pengingat Shalat (Tanpa tag)
    cron.schedule('0 3 * * *', async () => {
        const teksPengingat = `Ikhwan & Akhwat sudah saatnya bangun nih, kita laksanakan shalat tahajud, yu semangat bangun terus ambil wudhu dan amparkan sajadahnya`;
        await sock.sendMessage(TARGET_GROUP_ID, { text: teksPengingat });
        console.log('Pengingat jam 03.00 berhasil dikirim.');
    }, { timezone: TIMEZONE });

    // 3. Pukul 06.00 WIB: Rekap Diam-diam ke Google Sheets
    cron.schedule('0 6 * * *', async () => {
        const currentVotes = getVotesData();
        if (Object.keys(currentVotes).length > 0) {
            await saveToGoogleSheets(currentVotes);
            console.log('Proses rekap harian jam 06.00 ke spreadsheet selesai.');
        } else {
            console.log('Tidak ada data vote untuk direkap pagi ini.');
        }
    }, { timezone: TIMEZONE });
}

connectToWhatsApp();
