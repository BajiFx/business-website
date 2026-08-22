// ================================================================
//  DATABASE BACKUP SCRIPT
//  Run: node scripts/backup-database.js
// ================================================================

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const backupDir = path.join(__dirname, '../backups');

// Create backup directory if it doesn't exist
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(backupDir, `backup-${timestamp}.sql`);

console.log('🔄 Starting database backup...');
console.log(`📁 Backup location: ${backupFile}`);

// Parse DATABASE_URL
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('❌ DATABASE_URL not found in .env');
  process.exit(1);
}

// Extract connection details from URL
const match = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
if (!match) {
  console.error('❌ Invalid DATABASE_URL format');
  process.exit(1);
}

const [, user, password, host, port, database] = match;

// Build pg_dump command
const command = `PGPASSWORD=${password} pg_dump -h ${host} -p ${port} -U ${user} -d ${database} > "${backupFile}"`;

console.log('📤 Executing backup...');

exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error('❌ Backup failed:', error.message);
    console.error('Stderr:', stderr);
    process.exit(1);
  }
  
  // Check if backup file exists and has content
  if (fs.existsSync(backupFile)) {
    const stats = fs.statSync(backupFile);
    if (stats.size > 0) {
      console.log(`✅ Backup successful!`);
      console.log(`📁 File: ${backupFile}`);
      console.log(`📊 Size: ${(stats.size / 1024).toFixed(2)} KB`);
      
      // Create a summary file with backup info
      const summary = {
        timestamp: new Date().toISOString(),
        file: backupFile,
        size: stats.size,
        database: database
      };
      fs.writeFileSync(
        path.join(backupDir, `backup-${timestamp}.json`),
        JSON.stringify(summary, null, 2)
      );
      
      // Keep only last 10 backups
      const files = fs.readdirSync(backupDir)
        .filter(f => f.endsWith('.sql'))
        .map(f => ({
          name: f,
          time: fs.statSync(path.join(backupDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);
      
      if (files.length > 10) {
        const toDelete = files.slice(10);
        toDelete.forEach(f => {
          fs.unlinkSync(path.join(backupDir, f.name));
          console.log(`🗑️ Deleted old backup: ${f.name}`);
        });
      }
      
      process.exit(0);
    } else {
      console.error('❌ Backup file is empty');
      process.exit(1);
    }
  } else {
    console.error('❌ Backup file not created');
    process.exit(1);
  }
});