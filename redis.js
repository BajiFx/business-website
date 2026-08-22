// ================================================================
//  REDIS CACHE SETUP
//  Location: /redis.js (root folder)
// ================================================================

const redis = require('redis');

let client = null;
let isConnected = false;

function getRedisClient() {
  if (client && isConnected) return client;
  
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  
  try {
    client = redis.createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          console.log(`🔄 Redis reconnect attempt ${retries}`);
          return Math.min(retries * 100, 3000);
        }
      }
    });
    
    client.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
      isConnected = false;
    });
    
    client.on('connect', () => {
      console.log('✅ Redis connected');
      isConnected = true;
    });
    
    client.on('reconnecting', () => {
      console.log('🔄 Redis reconnecting...');
    });
    
    client.on('end', () => {
      console.log('🔌 Redis disconnected');
      isConnected = false;
    });
    
    // Connect async
    client.connect().catch(err => {
      console.warn('⚠️ Redis connection failed:', err.message);
      console.log('📌 Caching will be disabled');
      client = null;
      isConnected = false;
    });
    
    return client;
  } catch (err) {
    console.warn('⚠️ Redis initialization failed:', err.message);
    console.log('📌 Caching will be disabled');
    return null;
  }
}

// Cache helper functions
async function getCache(key) {
  if (!client || !isConnected) return null;
  try {
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.warn('⚠️ Cache get error:', err.message);
    return null;
  }
}

async function setCache(key, data, ttl = 300) {
  if (!client || !isConnected) return false;
  try {
    await client.set(key, JSON.stringify(data), { EX: ttl });
    return true;
  } catch (err) {
    console.warn('⚠️ Cache set error:', err.message);
    return false;
  }
}

async function deleteCache(key) {
  if (!client || !isConnected) return false;
  try {
    await client.del(key);
    return true;
  } catch (err) {
    console.warn('⚠️ Cache delete error:', err.message);
    return false;
  }
}

async function clearCache(pattern = '*') {
  if (!client || !isConnected) return false;
  try {
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(keys);
    }
    return true;
  } catch (err) {
    console.warn('⚠️ Cache clear error:', err.message);
    return false;
  }
}

// Cache middleware for Express
function cacheMiddleware(ttl = 300) {
  return async (req, res, next) => {
    // Skip if redis not available or not GET
    if (!client || !isConnected || req.method !== 'GET') {
      return next();
    }
    
    // Skip admin routes
    if (req.path.includes('/admin')) {
      return next();
    }
    
    const cacheKey = `cache:${req.originalUrl}`;
    
    try {
      const cached = await client.get(cacheKey);
      if (cached) {
        console.log(`📦 Cache hit: ${req.originalUrl}`);
        return res.json(JSON.parse(cached));
      }
    } catch (err) {
      // Redis error, proceed without cache
    }
    
    // Store original json method
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      try {
        if (client && isConnected && res.statusCode === 200) {
          client.set(cacheKey, JSON.stringify(data), { EX: ttl })
            .catch(err => console.warn('Cache set error:', err.message));
        }
      } catch (err) {
        // Cache error, ignore
      }
      return originalJson(data);
    };
    
    next();
  };
}

module.exports = { 
  getRedisClient, 
  getCache, 
  setCache, 
  deleteCache, 
  clearCache, 
  cacheMiddleware 
};