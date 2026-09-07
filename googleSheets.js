const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('./credentials.json'); // Pastikan file ini ada di folder yang sama

// GANTI DENGAN SPREADSHEET ID ANDA
const SPREADSHEET_ID = '11oqVmxfVwySlBiNI6jD8NfSkdBniTwSzI-2Bgg9wNKY'; 

const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
  ],
});

async function appendToSheet(rowsData) {
  try {
    console.log("Menyambungkan ke Google Sheets...");
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    
    // Muat info dokumen
    await doc.loadInfo(); 
    
    // Ambil sheet pertama (index 0)
    const sheet = doc.sheetsByIndex[0]; 
    
    // Tambahkan banyak baris sekaligus
    await sheet.addRows(rowsData);
    console.log(`Berhasil menyimpan ${rowsData.length} data ke Spreadsheet!`);
    return true;
  } catch (error) {
    console.error("Gagal menyimpan ke Google Sheets:", error);
    return false;
  }
}

module.exports = { appendToSheet };