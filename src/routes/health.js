const express = require('express');
const router = express.Router();
const { query } = require('../database/connection');

// Health check endpoint
router.get('/', async (req, res) => {
  try {
    // Test database connection
    const dbResult = await query('SELECT NOW() as timestamp');
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        whatsapp: 'ready',
        ai: 'ready'
      },
      database: {
        timestamp: dbResult.rows[0].timestamp
      },
      version: '1.0.0'
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Detailed health check
router.get('/detailed', async (req, res) => {
  try {
    const checks = {
      database: false,
      environment: false,
      services: {}
    };

    // Check database
    try {
      await query('SELECT 1');
      checks.database = true;
    } catch (error) {
      checks.database = false;
    }

    // Check environment variables
    const requiredEnvVars = [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_WHATSAPP_NUMBER',
      'OPENAI_API_KEY',
      'DATABASE_URL',
      'GOOGLE_MAPS_API_KEY'
    ];

    checks.environment = requiredEnvVars.every(varName => process.env[varName]);

    res.json({
      status: checks.database && checks.environment ? 'healthy' : 'unhealthy',
      checks,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router; 