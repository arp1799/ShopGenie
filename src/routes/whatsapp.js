const express = require('express');
const router = express.Router();
const twilio = require('twilio');

// Import services
const whatsappService = require('../services/whatsappService');
const aiService = require('../services/aiService');
const userService = require('../services/userService');
const cartService = require('../services/cartService');

// Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Webhook verification for Twilio (simplified for sandbox)
router.get('/', (req, res) => {
  // For Twilio sandbox, we don't need complex verification
  res.status(200).send('WhatsApp webhook is ready');
});

// Main webhook endpoint for incoming messages
router.post('/', async (req, res) => {
  try {
    // Verify the request is from Twilio
    const signature = req.headers['x-twilio-signature'];
    const url = `${process.env.APP_BASE_URL}/webhook`;
    const params = req.body;
    
    const isValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      params
    );

    if (!isValid) {
      console.log('❌ Invalid Twilio signature');
      return res.status(403).send('Forbidden');
    }

    // Extract message details
    const message = req.body.Body;
    const from = req.body.From; // WhatsApp number
    const messageSid = req.body.MessageSid;

    console.log(`📱 Received message from ${from}: ${message}`);

    // Check if user is allowed (for Phase 1)
    const allowedRecipients = process.env.ALLOWED_RECIPIENTS.split(',');
    if (!allowedRecipients.includes(from)) {
      console.log(`❌ Unauthorized user: ${from}`);
      await whatsappService.sendMessage(
        from,
        "❌ This bot is currently in private beta. Please wait for public release."
      );
      return res.status(200).send('OK');
    }

    // Process the message
    await processMessage(from, message, messageSid);

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Process incoming message
async function processMessage(from, message, messageSid) {
  try {
    // Get or create user
    let user = await userService.getUserByPhone(from);
    if (!user) {
      user = await userService.createUser(from);
      await whatsappService.sendMessage(
        from,
        "👋 Welcome to ShopGenie AI! 🛒\n\nI can help you compare prices across grocery platforms and build your cart.\n\nTry saying: 'Order milk and bread to 123 Main St, Bangalore'"
      );
      return;
    }

    // Log the message
    await userService.logMessage(user.id, 'inbound', message, { messageSid });

    // Check for special commands
    if (message.toLowerCase().includes('help') || message.toLowerCase().includes('start')) {
      await sendHelpMessage(from);
      return;
    }

    if (message.toLowerCase().includes('stop') || message.toLowerCase().includes('unsubscribe')) {
      await userService.updateUserAllowed(user.id, false);
      await whatsappService.sendMessage(
        from,
        "👋 You've been unsubscribed from ShopGenie AI. Send 'start' to re-enable."
      );
      return;
    }

    // Use AI to parse the message
    const parsedIntent = await aiService.parseMessage(message);
    
    if (parsedIntent.intent === 'order') {
      await handleOrderIntent(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'add_item') {
      await handleAddItemIntent(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'remove_item') {
      await handleRemoveItemIntent(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'address_confirmation') {
      await handleAddressConfirmation(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'retailer_selection') {
      await handleRetailerSelection(from, user, parsedIntent);
    } else {
      await whatsappService.sendMessage(
        from,
        "🤔 I didn't understand that. Try saying:\n\n'Order milk and bread to 123 Main St, Bangalore'\n\nOr type 'help' for more options."
      );
    }

  } catch (error) {
    console.error('❌ Error processing message:', error);
    await whatsappService.sendMessage(
      from,
      "😔 Sorry, I encountered an error. Please try again or type 'help' for assistance."
    );
  }
}

// Handle order intent
async function handleOrderIntent(from, user, parsedIntent) {
  try {
    // Check if user has a confirmed address
    const userAddress = await userService.getUserPrimaryAddress(user.id);
    
    if (!userAddress && parsedIntent.address) {
      // Validate and save address
      const validatedAddress = await aiService.validateAddress(parsedIntent.address);
      if (validatedAddress) {
        await userService.saveAddress(user.id, validatedAddress);
        await sendAddressConfirmation(from, validatedAddress);
        return;
      }
    }

    if (!userAddress) {
      await whatsappService.sendMessage(
        from,
        "📍 Please provide your delivery address first.\n\nExample: 'My address is 123 Main St, Bangalore 560001'"
      );
      return;
    }

    // Create or get active cart
    let cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      cart = await cartService.createCart(user.id);
    }

    // Add items to cart
    for (const item of parsedIntent.items) {
      await cartService.addItemToCart(cart.id, item);
    }

    // Get price comparisons
    const priceComparisons = await cartService.getPriceComparisons(cart.id);
    
    // Send price comparison message
    await sendPriceComparison(from, priceComparisons);

  } catch (error) {
    console.error('❌ Error handling order intent:', error);
    throw error;
  }
}

// Handle add item intent
async function handleAddItemIntent(from, user, parsedIntent) {
  try {
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 You don't have an active cart. Start by saying 'Order [items]'"
      );
      return;
    }

    for (const item of parsedIntent.items) {
      await cartService.addItemToCart(cart.id, item);
    }

    await whatsappService.sendMessage(
      from,
      `✅ Added ${parsedIntent.items.length} item(s) to your cart.\n\nType 'show cart' to see your current items.`
    );

  } catch (error) {
    console.error('❌ Error handling add item intent:', error);
    throw error;
  }
}

// Handle remove item intent
async function handleRemoveItemIntent(from, user, parsedIntent) {
  try {
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 You don't have an active cart."
      );
      return;
    }

    // Implementation for removing items
    await whatsappService.sendMessage(
      from,
      "🔄 Item removal feature coming soon!"
    );

  } catch (error) {
    console.error('❌ Error handling remove item intent:', error);
    throw error;
  }
}

// Handle address confirmation
async function handleAddressConfirmation(from, user, parsedIntent) {
  try {
    if (parsedIntent.confirmed) {
      await userService.confirmAddress(user.id);
      await whatsappService.sendMessage(
        from,
        "✅ Address confirmed! Now you can start ordering.\n\nTry: 'Order milk and bread'"
      );
    } else {
      await whatsappService.sendMessage(
        from,
        "📍 Please provide your correct address.\n\nExample: 'My address is 123 Main St, Bangalore 560001'"
      );
    }
  } catch (error) {
    console.error('❌ Error handling address confirmation:', error);
    throw error;
  }
}

// Handle retailer selection
async function handleRetailerSelection(from, user, parsedIntent) {
  try {
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 You don't have an active cart."
      );
      return;
    }

    // Update cart with retailer choices
    await cartService.updateRetailerChoices(cart.id, parsedIntent.choices);
    
    // Generate final cart summary
    const finalCart = await cartService.generateFinalCart(cart.id);
    await sendFinalCartSummary(from, finalCart);

  } catch (error) {
    console.error('❌ Error handling retailer selection:', error);
    throw error;
  }
}

// Send help message
async function sendHelpMessage(from) {
  const helpText = `🛒 *ShopGenie AI Help*

*How to use:*
1. 📍 Set your address: "My address is 123 Main St, Bangalore"
2. 🛒 Order items: "Order milk and bread"
3. 🏪 Choose retailers: Select from the options provided
4. 🔗 Get cart links: Click the links to complete your order

*Commands:*
• help - Show this message
• stop - Unsubscribe from the service
• show cart - View current cart items

*Supported platforms:*
• Zepto
• Blinkit  
• Swiggy Instamart

*Example:*
"Order 2L Amul milk and 1 loaf bread to 123 Main St, Bangalore 560001"

Need help? Just type your question!`;

  await whatsappService.sendMessage(from, helpText);
}

// Send address confirmation
async function sendAddressConfirmation(from, address) {
  const message = `📍 *Confirm your delivery address:*

${address.formatted}

Is this correct?
Reply with:
✅ Yes
❌ No`;

  await whatsappService.sendMessage(from, message);
}

// Send price comparison
async function sendPriceComparison(from, comparisons) {
  let message = "🛒 *Price Comparison:*\n\n";
  
  for (const item of comparisons) {
    message += `*${item.name}*\n`;
    for (const price of item.prices) {
      message += `• ${price.retailer}: ₹${price.price}\n`;
    }
    message += "\n";
  }

  message += "Select your preferred retailer for each item by replying with the retailer name.";

  await whatsappService.sendMessage(from, message);
}

// Send final cart summary
async function sendFinalCartSummary(from, finalCart) {
  let message = "✅ *Your Final Cart:*\n\n";
  
  for (const [retailer, items] of Object.entries(finalCart.retailerCarts)) {
    message += `*${retailer}:*\n`;
    for (const item of items) {
      message += `• ${item.name}: ₹${item.price}\n`;
    }
    message += `Total: ₹${finalCart.retailerTotals[retailer]}\n\n`;
  }

  message += `*Grand Total: ₹${finalCart.grandTotal}*\n\n`;
  message += "Click the links below to complete your order:";

  await whatsappService.sendMessage(from, message);
  
  // Send deep links for each retailer
  for (const [retailer, link] of Object.entries(finalCart.deepLinks)) {
    await whatsappService.sendMessage(
      from,
      `🛒 ${retailer}: ${link}`
    );
  }
}

module.exports = router; 