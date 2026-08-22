// ================================================================
//  LOCATION DATA SYNC SCRIPT
//  Run: node scripts/sync-locations.js
// ================================================================

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Kenyan Counties with their sub-counties
const locationData = {
  'Mombasa': ['Changamwe', 'Jomvu', 'Kisauni', 'Nyali', 'Likoni', 'Mvita'],
  'Kwale': ['Msambweni', 'Lunga Lunga', 'Matuga', 'Kinango'],
  'Kilifi': ['Kilifi North', 'Kilifi South', 'Kaloleni', 'Rabai', 'Ganze', 'Malindi', 'Magarini'],
  'Tana River': ['Garsen', 'Galole', 'Bura'],
  'Lamu': ['Lamu East', 'Lamu West'],
  'Taita-Taveta': ['Taveta', 'Wundanyi', 'Mwatate', 'Voi'],
  'Garissa': ['Garissa', 'Balambala', 'Lagdera', 'Dadaab', 'Fafi', 'Ijara'],
  'Wajir': ['Wajir North', 'Wajir East', 'Tarbaj', 'Wajir West', 'Eldas', 'Wajir South'],
  'Mandera': ['Mandera West', 'Banissa', 'Mandera North', 'Mandera South', 'Mandera East', 'Lafey'],
  'Marsabit': ['Moyale', 'North Horr', 'Saku', 'Laisamis'],
  'Isiolo': ['Isiolo', 'Garbatulla', 'Merti'],
  'Meru': ['Tigania East', 'Tigania West', 'Igembe Central', 'Igembe South', 'Igembe North', 'Buuri', 'Imenti Central', 'Imenti North', 'Imenti South'],
  'Tharaka-Nithi': ['Maara', 'Chuka', 'Tharaka'],
  'Embu': ['Manyatta', 'Runyenjes', 'Mbeere North', 'Mbeere South'],
  'Kitui': ['Kitui Central', 'Kitui West', 'Kitui South', 'Kitui East', 'Kitui Rural', 'Kitui North'],
  'Machakos': ['Masinga', 'Yatta', 'Kangundo', 'Matungulu', 'Kathiani', 'Mavoko', 'Machakos Town', 'Mwala'],
  'Makueni': ['Kilome', 'Kibwezi', 'Makindu', 'Makueni', 'Kathonzweni', 'Mbooni'],
  'Nyandarua': ['Kinangop', 'Kipipiri', 'Ol Kalou', 'Ol Joro Orok', 'Ndaragwa'],
  'Nyeri': ['Tetu', 'Kieni', 'Mathira', 'Othaya', 'Mukurweini', 'Nyeri Town'],
  'Kirinyaga': ['Mwea', 'Gichugu', 'Ndia', 'Kirinyaga Central'],
  'Murang\'a': ['Kangema', 'Mathioya', 'Kiharu', 'Kigumo', 'Maragwa', 'Kandara', 'Gatanga'],
  'Kiambu': ['Gatundu North', 'Gatundu South', 'Githunguri', 'Juja', 'Kabete', 'Kiambaa', 'Kiambu', 'Kikuyu', 'Limuru', 'Lari', 'Ruiru', 'Thika Town'],
  'Turkana': ['Turkana North', 'Turkana West', 'Turkana Central', 'Loima', 'Turkana South', 'Turkana East'],
  'West Pokot': ['Kapenguria', 'Sigor', 'Kacheliba', 'Pokot South'],
  'Samburu': ['Samburu West', 'Samburu North', 'Samburu East'],
  'Trans-Nzoia': ['Kwanza', 'Endebess', 'Saboti', 'Kiminini', 'Cherangany'],
  'Uasin Gishu': ['Soy', 'Turbo', 'Moiben', 'Ainabkoi', 'Kapseret', 'Kesses'],
  'Elgeyo-Marakwet': ['Marakwet East', 'Marakwet West', 'Keiyo North', 'Keiyo South'],
  'Nandi': ['Tinderet', 'Aldai', 'Nandi Hills', 'Chesumei', 'Emgwen', 'Mosop'],
  'Baringo': ['Tiaty', 'Baringo North', 'Baringo Central', 'Baringo South', 'Mogotio', 'Eldama Ravine'],
  'Laikipia': ['Laikipia North', 'Laikipia East', 'Laikipia West'],
  'Nakuru': ['Molo', 'Njoro', 'Naivasha', 'Gilgil', 'Kuresoi South', 'Kuresoi North', 'Subukia', 'Rongai', 'Bahati', 'Nakuru Town West', 'Nakuru Town East'],
  'Narok': ['Kilgoris', 'Emurua Dikirr', 'Narok North', 'Narok East', 'Narok South', 'Narok West'],
  'Kajiado': ['Kajiado North', 'Kajiado Central', 'Kajiado East', 'Kajiado West', 'Kajiado South'],
  'Kericho': ['Kericho', 'Bureti', 'Belgut', 'Sigowet/Soin'],
  'Bomet': ['Sotik', 'Chepalungu', 'Bomet East', 'Bomet Central', 'Konoin'],
  'Kakamega': ['Kakamega Central', 'Kakamega East', 'Kakamega North', 'Kakamega South', 'Kakamega West', 'Lugari', 'Matungu', 'Mumias', 'Navakholo'],
  'Vihiga': ['Vihiga', 'Sabatia', 'Hamisi', 'Luanda', 'Emuhaya'],
  'Bungoma': ['Bungoma Central', 'Bungoma East', 'Bungoma North', 'Bungoma South', 'Bungoma West', 'Kimilili', 'Tongaren', 'Mt. Elgon', 'Cheptais', 'Sirisia', 'Kanduyi'],
  'Busia': ['Teso North', 'Teso South', 'Nambale', 'Matayos', 'Butula', 'Funyula', 'Budalangi'],
  'Siaya': ['Ugenya', 'Ugunja', 'Alego Usonga', 'Gem', 'Rarieda', 'Bondo'],
  'Kisumu': ['Kisumu East', 'Kisumu West', 'Kisumu Central', 'Seme', 'Muhoroni', 'Nyando'],
  'Homa Bay': ['Kasipul', 'Kabondo Kasipul', 'Karachuonyo', 'Rangwe', 'Homa Bay Town', 'Ndhiwa', 'Suba North', 'Suba South'],
  'Migori': ['Rongo', 'Awendo', 'Suna East', 'Suna West', 'Uriri', 'Nyatike', 'Kuria East', 'Kuria West'],
  'Kisii': ['Bonchari', 'South Mugirango', 'Bomachoge Borabu', 'Bobasi', 'Bomachoge Chache', 'Nyaribari Masaba', 'Nyaribari Chache', 'Kitutu Chache North', 'Kitutu Chache South'],
  'Nyamira': ['Kitutu Masaba', 'North Mugirango', 'West Mugirango', 'Borabu'],
  'Nairobi': ['Dagoretti North', 'Dagoretti South', 'Embakasi Central', 'Embakasi East', 'Embakasi North', 'Embakasi South', 'Embakasi West', 'Kasarani', 'Kibra', 'Lang''ata', 'Makadara', 'Mathare', 'Roysambu', 'Ruaraka', 'Starehe', 'Westlands']
};

async function syncLocations() {
  console.log('🔄 Syncing location data...');
  console.log(`📋 Found ${Object.keys(locationData).length} counties`);
  
  try {
    let countyCount = 0;
    let subCountyCount = 0;
    
    for (const [countyName, subCounties] of Object.entries(locationData)) {
      // Check if county exists
      const existingCounty = await pool.query(
        'SELECT id FROM counties WHERE name = $1',
        [countyName]
      );
      
      let countyId;
      if (existingCounty.rows.length > 0) {
        countyId = existingCounty.rows[0].id;
        console.log(`⏭️  County already exists: ${countyName}`);
      } else {
        // Insert county
        const countyResult = await pool.query(
          `INSERT INTO counties (code, name) 
           VALUES ($1, $2) 
           RETURNING id`,
          [String(Date.now()).slice(-5) + String(countyCount + 1).padStart(3, '0'), countyName]
        );
        countyId = countyResult.rows[0].id;
        countyCount++;
        console.log(`✅ County: ${countyName}`);
      }
      
      for (const subCountyName of subCounties) {
        // Check if sub-county exists
        const existingSubCounty = await pool.query(
          'SELECT id FROM sub_counties WHERE name = $1 AND county_id = $2',
          [subCountyName, countyId]
        );
        
        if (existingSubCounty.rows.length > 0) {
          continue;
        }
        
        // Insert sub-county
        await pool.query(
          `INSERT INTO sub_counties (county_id, code, name) 
           VALUES ($1, $2, $3)`,
          [countyId, `${String(countyId).padStart(5, '0')}${String(subCounties.indexOf(subCountyName) + 1).padStart(2, '0')}`, subCountyName]
        );
        subCountyCount++;
        console.log(`  ✅ Sub-County: ${subCountyName}`);
      }
    }
    
    console.log(`🎉 Location sync completed!`);
    console.log(`   Added ${countyCount} new counties`);
    console.log(`   Added ${subCountyCount} new sub-counties`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    process.exit(1);
  }
}

syncLocations();