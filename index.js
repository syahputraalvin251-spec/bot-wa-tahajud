const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const pino = require('pino');
const { appendToSheet } = require('./googleSheets.js');

// GANTI DENGAN ID GRUP ANDA NANTI (Setelah dapat dari !cekid)
const TARGET_GROUP_ID = '120363429342229342@g.us'; 
const TIMEZONE = 'Asia/Jakarta'; // Waktu Indonesia Barat (WIB)

let dailyVotes = {}; // Menyimpan hasil absen sementara
let isAbsenOpen = false; // Penanda apakah sesi absen sedang dibuka (jam 21.00 - 06.00)

async function connectToWhatsApp() {
    // Menyimpan sesi login agar tidak perlu scan QR terus menerus
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // Inisialisasi koneksi socket WhatsApp
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Kita matikan bawaan agar bisa pakai qrcode-terminal yang lebih rapi
        logger: pino({ level: 'silent' }), // Menyembunyikan log rumit dari terminal
        browser: ['Bot Tahajud', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Jika ada QR Code baru, tampilkan di terminal
        if (qr) {
            console.log('\n=========================================');
            console.log('SCAN QR CODE DI BAWAH INI DENGAN WHATSAPP');
            console.log('=========================================\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Mencoba menghubungkan kembali...', shouldReconnect);
            // Hubungkan ulang jika tidak di-logout manual
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('\n✅ Bot WhatsApp berhasil terhubung dan siap digunakan!');
            scheduleJobs(sock); // Mulai penjadwalan CRON setelah bot siap
        }
    });

    // Simpan kredensial login setiap kali ada pembaruan
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        
        // Abaikan jika pesan dikirim oleh bot itu sendiri
        if (!msg.message || msg.key.fromMe) return;

        const senderId = msg.key.remoteJid; // ID Pengirim (bisa ID Grup atau Pribadi)
        const participantId = msg.key.participant || msg.key.remoteJid; // Nomor WA asli pengirim
        
        // Ambil isi teks pesan (mendukung pesan biasa atau pesan balasan)
        const textMessage = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || "";
        const teks = textMessage.toLowerCase().trim();

        // 1. FITUR BANTUAN: !cekid
        if (teks === '!cekid') {
            if (senderId.endsWith('@g.us')) {
                await sock.sendMessage(senderId, { text: `ID Grup ini adalah: ${senderId}` }, { quoted: msg });
                console.log(`ID Grup ditemukan: ${senderId}`);
            } else {
                await sock.sendMessage(senderId, { text: 'Perintah ini hanya bisa digunakan di dalam grup.' });
            }
            return;
        }

        // 2. FITUR ABSENSI
        // Hanya memproses absensi jika sesi absen sedang dibuka dan pesan berasal dari grup target
        if (isAbsenOpen && senderId === TARGET_GROUP_ID) {
            // Ambil nama pengirim, jika tidak ada pakai 'Hamba Allah'
            const pushName = msg.pushName || 'Hamba Allah';
            // Ambil nomor WA saja (menghilangkan @s.whatsapp.net)
            const phoneNumber = participantId.split('@')[0];

            let pilihan = null;

            // Logika sederhana: deteksi angka 1 atau 2, atau kata kunci
            if (teks === '1' || teks.includes('qiyamul lail')) {
                pilihan = 'Qiyamul Lail';
            } else if (teks === '2' || teks.includes('tahajud')) {
                pilihan = 'Tahajud';
            } else if (teks === 'batal' || teks === '0') {
                // Fitur untuk membatalkan absen
                if (dailyVotes[participantId]) {
                    delete dailyVotes[participantId];
                    console.log(`[ABSEN] ${pushName} membatalkan absen.`);
                    await sock.sendMessage(senderId, { text: `Tercatat, absen dibatalkan untuk ${pushName}.` }, { quoted: msg });
                }
                return;
            }

            // Jika pilihan valid, simpan ke dalam memori bot
            if (pilihan) {
                dailyVotes[participantId] = {
                    name: pushName,
                    phone: phoneNumber,
                    choice: pilihan
                };
                console.log(`[ABSEN] ${pushName} melaporkan: ${pilihan}`);
                // React dengan emoji centang agar pengirim tahu pesannya masuk (opsional)
                await sock.sendMessage(senderId, { react: { text: "✅", key: msg.key } });
            }
        }
    });
}

function scheduleJobs(sock) {
    // 1. Pengingat Jam 3 Pagi
    cron.schedule('0 3 * * *', async () => {
        console.log('[CRON] Mengirim pesan pengingat Tahajud...');
        try {
            await sock.sendMessage(TARGET_GROUP_ID, { 
                text: "Ikhwan & Akhwat sudah saatnya bangun nih, kita laksanakan shalat tahajud, yu semangat bangun terus ambil wudhu dan amparkan sajadahnya 🌙" 
            });
        } catch (error) {
            console.error("Gagal mengirim pesan tahajud:", error);
        }
    }, { timezone: TIMEZONE });

    // 2. Kirim Pesan Absensi Jam 9 Malam (21.00)
    cron.schedule('0 21 * * *', async () => {
        console.log('[CRON] Membuka sesi absensi malam...');
        dailyVotes = {}; // Bersihkan data kemarin
        isAbsenOpen = true; // Buka sesi absensi

        const pesanAbsen = `📋 *Absensi Ibadah Malam* 📋\n\nHari ini shalat apa yang dilaksanakan?\nSilakan balas pesan ini dengan mengetik angka:\n\n*1* - Qiyamul Lail\n*2* - Tahajud\n\n_(Ketik '0' untuk membatalkan absen)_`;

        try {
            await sock.sendMessage(TARGET_GROUP_ID, { text: pesanAbsen });
        } catch (error) {
            console.error("Gagal mengirim pesan absensi:", error);
        }
    }, { timezone: TIMEZONE });

    // 3. Rekap Otomatis Jam 6 Pagi
    cron.schedule('0 6 * * *', async () => {
        console.log('[CRON] Memulai proses rekapitulasi data ke Google Sheets...');
        isAbsenOpen = false; // Tutup sesi absensi
        
        const dateObj = new Date();
        // Memformat jadi DD/MM/YYYY
        const dateString = `${dateObj.getDate().toString().padStart(2, '0')}/${(dateObj.getMonth() + 1).toString().padStart(2, '0')}/${dateObj.getFullYear()}`;
        
        const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
        const monthString = `${monthNames[dateObj.getMonth()]} ${dateObj.getFullYear()}`;
        
        // Format data menjadi array yang siap dimasukkan ke Google Sheets
        const rowsData = Object.values(dailyVotes).map(user => {
            return {
                'Tanggal': dateString,
                'Bulan': monthString,
                'Nama': user.name,
                'Nomor WA': user.phone,
                'Pilihan': user.choice
            };
        });

        if (rowsData.length > 0) {
            const isSuccess = await appendToSheet(rowsData);
            if (isSuccess) {
                const rekapMsg = `✅ *Rekapan Ibadah Malam Selesai*\nTanggal: ${dateString}\nTotal Partisipan: ${rowsData.length} orang.\nData telah otomatis tersimpan ke Spreadsheet.`;
                await sock.sendMessage(TARGET_GROUP_ID, { text: rekapMsg });
            } else {
                await sock.sendMessage(TARGET_GROUP_ID, { text: `❌ Gagal menyimpan rekapan ke Spreadsheet hari ini. Cek log server.` });
            }
        } else {
            await sock.sendMessage(TARGET_GROUP_ID, { text: `ℹ️ Rekapan ditutup. Tidak ada partisipan ibadah malam ini.` });
        }

        // Bersihkan data setelah direkap
        dailyVotes = {};
    }, { timezone: TIMEZONE });
    
    console.log("✅ Semua jadwal waktu (CRON) telah diaktifkan.");
}

// Jalankan fungsi utama
connectToWhatsApp();