const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
async function testConnection() {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('✅ Database connection test successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection test failed:', error);
    return false;
  }
}

// Initialize database tables
async function initializeTables() {
  try {
    const client = await pool.connect();
    
    // Check if we need to create missing tables
    const tableCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('addresses', 'price_quotes', 'messages_log')
    `);
    
    const existingTables = tableCheck.rows.map(row => row.table_name);
    const missingTables = ['addresses', 'price_quotes', 'messages_log'].filter(
      table => !existingTables.includes(table)
    );
    
    // Create missing tables if they don't exist
    if (missingTables.includes('addresses')) {
      await client.query(`
        CREATE TABLE addresses (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          raw_input TEXT NOT NULL,
          formatted TEXT,
          lat DOUBLE PRECISION,
          lng DOUBLE PRECISION,
          pincode VARCHAR(10),
          components JSONB,
          is_primary BOOLEAN DEFAULT false,
          confirmed BOOLEAN DEFAULT false,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);
      console.log('✅ Created addresses table');
    }

    if (missingTables.includes('price_quotes')) {
      await client.query(`
        CREATE TABLE price_quotes (
          id SERIAL PRIMARY KEY,
          cart_item_id INTEGER REFERENCES cart_items(id) ON DELETE CASCADE,
          retailer VARCHAR(50),
          product_title TEXT,
          unit_price NUMERIC(12,2),
          currency VARCHAR(3) DEFAULT 'INR',
          product_url TEXT,
          image_url TEXT,
          metadata JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);
      console.log('✅ Created price_quotes table');
    }

    if (missingTables.includes('messages_log')) {
      await client.query(`
        CREATE TABLE messages_log (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          message_type VARCHAR(20) DEFAULT 'inbound',
          content TEXT,
          metadata JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);
      console.log('✅ Created messages_log table');
    }

    // Add missing columns to existing tables if needed
    const userColumns = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND table_schema = 'public'
    `);
    
    const userColumnNames = userColumns.rows.map(row => row.column_name);
    
    if (!userColumnNames.includes('allowed')) {
      await client.query('ALTER TABLE users ADD COLUMN allowed BOOLEAN DEFAULT true');
      console.log('✅ Added allowed column to users table');
    }
    
    if (!userColumnNames.includes('updated_at')) {
      await client.query('ALTER TABLE users ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()');
      console.log('✅ Added updated_at column to users table');
    }
    
    if (!userColumnNames.includes('session_data')) {
      await client.query('ALTER TABLE users ADD COLUMN session_data JSONB DEFAULT \'{}\'');
      console.log('✅ Added session_data column to users table');
    }

    // Check cart_items table structure
    const cartItemsColumns = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'cart_items' 
      AND table_schema = 'public'
    `);
    
    const cartItemsColumnNames = cartItemsColumns.rows.map(row => row.column_name);
    
    if (!cartItemsColumnNames.includes('normalized_name')) {
      await client.query('ALTER TABLE cart_items ADD COLUMN normalized_name TEXT');
      console.log('✅ Added normalized_name column to cart_items table');
    }
    
    if (!cartItemsColumnNames.includes('unit')) {
      await client.query('ALTER TABLE cart_items ADD COLUMN unit VARCHAR(20)');
      console.log('✅ Added unit column to cart_items table');
    }
    
    if (!cartItemsColumnNames.includes('notes')) {
      await client.query('ALTER TABLE cart_items ADD COLUMN notes TEXT');
      console.log('✅ Added notes column to cart_items table');
    }
    
    if (!cartItemsColumnNames.includes('query')) {
      await client.query('ALTER TABLE cart_items ADD COLUMN query TEXT');
      console.log('✅ Added query column to cart_items table');
    }
    
    // Check if product_name column exists and add it if not
    if (!cartItemsColumnNames.includes('product_name')) {
      await client.query('ALTER TABLE cart_items ADD COLUMN product_name TEXT');
      console.log('✅ Added product_name column to cart_items table');
    }

    // Check carts table structure
    const cartsColumns = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'carts' 
      AND table_schema = 'public'
    `);
    
    const cartsColumnNames = cartsColumns.rows.map(row => row.column_name);
    
    if (!cartsColumnNames.includes('retailer_choices')) {
      await client.query('ALTER TABLE carts ADD COLUMN retailer_choices JSONB');
      console.log('✅ Added retailer_choices column to carts table');
    }
    
    if (!cartsColumnNames.includes('deep_links')) {
      await client.query('ALTER TABLE carts ADD COLUMN deep_links JSONB');
      console.log('✅ Added deep_links column to carts table');
    }

    // Create retailer_credentials table if it doesn't exist
    const retailerCredentialsExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'retailer_credentials'
      );
    `);

    if (!retailerCredentialsExists.rows[0].exists) {
      await client.query(`
        CREATE TABLE retailer_credentials (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          retailer VARCHAR(50) NOT NULL,
          login_id VARCHAR(255) NOT NULL,
          login_type VARCHAR(20) NOT NULL DEFAULT 'email',
          encrypted_password TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, retailer)
        );
      `);
      console.log('✅ Created retailer_credentials table');
    } else {
      // Check if the table needs to be updated (migration from old schema)
      const retailerCredentialsColumns = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'retailer_credentials' 
        AND table_schema = 'public'
      `);
      
      const retailerCredentialsColumnNames = retailerCredentialsColumns.rows.map(row => row.column_name);
      
      // Check if login_id column exists, if not, add it
      if (!retailerCredentialsColumnNames.includes('login_id')) {
        console.log('🔄 Migrating retailer_credentials table to new schema...');
        
        // Add login_id column
        await client.query('ALTER TABLE retailer_credentials ADD COLUMN login_id VARCHAR(255)');
        
        // Copy data from email column to login_id if email column exists
        if (retailerCredentialsColumnNames.includes('email')) {
          await client.query('UPDATE retailer_credentials SET login_id = email WHERE login_id IS NULL');
          console.log('✅ Migrated email data to login_id column');
        }
        
        // Add login_type column if it doesn't exist
        if (!retailerCredentialsColumnNames.includes('login_type')) {
          await client.query('ALTER TABLE retailer_credentials ADD COLUMN login_type VARCHAR(20) DEFAULT \'email\'');
        }
        
        console.log('✅ Successfully migrated retailer_credentials table');
      }
      
      // If email column still exists and has NOT NULL constraint, make it nullable
      if (retailerCredentialsColumnNames.includes('email')) {
        try {
          await client.query('ALTER TABLE retailer_credentials ALTER COLUMN email DROP NOT NULL');
          console.log('✅ Made email column nullable');
        } catch (error) {
          console.log('ℹ️ Email column already nullable or constraint already dropped');
        }
      }
    }

    // Create indexes for better performance
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_carts_user_id ON carts(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON cart_items(cart_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_price_quotes_cart_item_id ON price_quotes(cart_item_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_messages_log_user_id ON messages_log(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_messages_log_created_at ON messages_log(created_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_retailer_credentials_user_id ON retailer_credentials(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_retailer_credentials_retailer ON retailer_credentials(retailer)');
    
    client.release();
    
    console.log('✅ Database tables initialized successfully');
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize database tables:', error);
    throw error;
  }
}

// Initialize database
async function initializeDatabase() {
  try {
    // Test connection first
    const connectionOk = await testConnection();
    if (!connectionOk) {
      throw new Error('Database connection failed');
    }

    // Initialize tables
    await initializeTables();
    
    return true;
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

// Helper function to get a client from the pool
async function getClient() {
  return await pool.connect();
}

// Helper function to execute a query
async function query(text, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

// Close the pool
async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  initializeDatabase,
  testConnection,
  getClient,
  query,
  closePool
}; 