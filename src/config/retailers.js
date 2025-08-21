/**
 * Supported retailers configuration
 * This file defines which retailers are available for scraping
 */

const SUPPORTED_RETAILERS = [
  {
    name: 'zepto',
    displayName: 'Zepto',
    loginMethods: ['email', 'phone'],
    baseUrl: 'https://www.zepto.in',
    searchUrl: 'https://www.zepto.in/search',
    loginUrl: 'https://www.zepto.in/login',
    deliveryTime: '10 min',
    description: '10-minute grocery delivery'
  },
  {
    name: 'blinkit',
    displayName: 'Blinkit',
    loginMethods: ['email', 'phone'],
    baseUrl: 'https://blinkit.com',
    searchUrl: 'https://blinkit.com/s',
    loginUrl: 'https://blinkit.com/login',
    deliveryTime: '9 min',
    description: '9-minute grocery delivery'
  },
  {
    name: 'instamart',
    displayName: 'Swiggy Instamart',
    loginMethods: ['email', 'phone'],
    baseUrl: 'https://www.swiggy.com/instamart',
    searchUrl: 'https://www.swiggy.com/instamart',
    loginUrl: 'https://www.swiggy.com/login',
    deliveryTime: '15 min',
    description: '15-minute grocery delivery'
  }
];

/**
 * Get list of supported retailers
 * @returns {Array} - Array of supported retailers
 */
function getSupportedRetailers() {
  return SUPPORTED_RETAILERS;
}

/**
 * Get retailer by name
 * @param {string} name - Retailer name
 * @returns {Object|null} - Retailer object or null
 */
function getRetailerByName(name) {
  return SUPPORTED_RETAILERS.find(retailer => 
    retailer.name.toLowerCase() === name.toLowerCase()
  );
}

/**
 * Check if retailer is supported
 * @param {string} name - Retailer name
 * @returns {boolean} - True if supported
 */
function isRetailerSupported(name) {
  return getRetailerByName(name) !== null;
}

/**
 * Get display names for supported retailers
 * @returns {Array} - Array of display names
 */
function getRetailerDisplayNames() {
  return SUPPORTED_RETAILERS.map(retailer => retailer.displayName);
}

module.exports = {
  SUPPORTED_RETAILERS,
  getSupportedRetailers,
  getRetailerByName,
  isRetailerSupported,
  getRetailerDisplayNames
}; 