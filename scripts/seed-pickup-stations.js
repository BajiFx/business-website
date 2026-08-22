// ================================================================
//  SEED PICKUP STATIONS
//  Run: node scripts/seed-pickup-stations.js
// ================================================================

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const pickupStations = [
  {
    name: 'Nairobi CBD Station',
    county: 'Nairobi',
    subCounty: 'Starehe',
    address: 'Moi Avenue, Nairobi CBD',
    lat: -1.286389,
    lng: 36.817223,
    phone: '0712345678',
    email: 'nairobi@pickup.com',
    hours: 'Mon-Sat: 8am-6pm, Sun: 10am-4pm'
  },
  {
    name: 'Westlands Pickup',
    county: 'Nairobi',
    subCounty: 'Westlands',
    address: 'Westlands, Nairobi',
    lat: -1.267089,
    lng: 36.803574,
    phone: '0722345678',
    email: 'westlands@pickup.com',
    hours: 'Mon-Sat: 8am-7pm, Sun: 9am-5pm'
  },
  {
    name: 'Kisumu Central',
    county: 'Kisumu',
    subCounty: 'Kisumu Central',
    address: 'Oginga Odinga Street, Kisumu',
    lat: -0.102210,
    lng: 34.761700,
    phone: '0732345678',
    email: 'kisumu@pickup.com',
    hours: 'Mon-Sat: 8am-6pm, Sun: Closed'
  },
  {
    name: 'Mombasa CBD',
    county: 'Mombasa',
    subCounty: 'Mvita',
    address: 'Moi Avenue, Mombasa',
    lat: -4.043477,
    lng: 39.668206,
    phone: '0742345678',
    email: 'mombasa@pickup.com',
    hours: 'Mon-Sat: 8am-6pm, Sun: 10am-4pm'
  },
  {
    name: 'Thika Road Mall',
    county: 'Kiambu',
    subCounty: 'Thika Town',
    address: 'Thika Road Mall, Thika',
    lat: -1.038889,
    lng: 37.083333,
    phone: '0752345678',
    email: 'thika@pickup.com',
    hours: 'Mon-Sun: 9am-9pm'
  },
  {
    name: 'Nakuru Town',
    county: 'Nakuru',
    subCounty: 'Nakuru Town East',
    address: 'Kenyatta Avenue, Nakuru',
    lat: -0.303099,
    lng: 36.080026,
    phone: '0762345678',
    email: 'nakuru@pickup.com',
    hours: 'Mon-Sat: 8am-6pm, Sun: 10am-4pm'
  },
  {
    name: 'Eldoret Central',
    county: 'Uasin Gishu',
    subCounty: 'Kapseret',
    address: 'Uganda Road, Eldoret',
    lat: 0.514277,
    lng: 35.269780,
    phone: '0772345678',
    email: 'eldoret@pickup.com',
    hours: 'Mon-Sat: 8am-6pm, Sun: 10am-3pm'
  },
  {
    name: 'Kakamega Town',
    county: 'Kakamega',
    subCounty: 'Kakamega Central',
    address: 'Kakamega Town Centre',
    lat: 0.282731,
    lng: 34.751865,
    phone: '0782345678',
    email: 'kakamega@pickup.com',
    hours: 'Mon-Sat: 8am-6pm, Sun: Closed'
  }
];

async function seedPickupStations() {
  console.log('🔄 Seeding pickup stations...');
  console.log(`📋 Found ${pickupStations.length} stations to seed`);
  
  try {
    let addedCount = 0;
    
    for (const station of pickupStations) {
      // Get county ID
      const countyResult = await pool.query(
        'SELECT id FROM counties WHERE name = $1',
        [station.county]
      );
      
      if (countyResult.rows.length === 0) {
        console.log(`⚠️ County not found: ${station.county}. Skipping...`);
        continue;
      }
      
      // Get sub-county ID
      const subCountyResult = await pool.query(
        'SELECT id FROM sub_counties WHERE name = $1 AND county_id = $2',
        [station.subCounty, countyResult.rows[0].id]
      );
      
      const subCountyId = subCountyResult.rows.length > 0 ? subCountyResult.rows[0].id : null;
      
      // Check if pickup station already exists
      const existing = await pool.query(
        'SELECT id FROM pickup_stations WHERE name = $1',
        [station.name]
      );
      
      if (existing.rows.length > 0) {
        console.log(`⏭️  Station already exists: ${station.name}`);
        continue;
      }
      
      // Insert pickup station
      await pool.query(
        `INSERT INTO pickup_stations (
          name, county_id, sub_county_id, address, 
          latitude, longitude, contact_phone, contact_email, 
          operating_hours, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
        [
          station.name, 
          countyResult.rows[0].id, 
          subCountyId, 
          station.address, 
          station.lat, 
          station.lng, 
          station.phone, 
          station.email, 
          station.hours
        ]
      );
      
      console.log(`✅ ${station.name}`);
      addedCount++;
    }
    
    console.log(`🎉 Pickup stations seeded! (${addedCount} new stations added)`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
}

seedPickupStations();