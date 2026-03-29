// Approval Page Script - Mkopo wa Mixx
document.addEventListener('DOMContentLoaded', function() {
    const applicationData = JSON.parse(sessionStorage.getItem('applicationData') || '{}');
    
    if (!applicationData.loanAmount) {
        console.warn('No application data found, using defaults');
    }
    
    const loanAmount = parseFloat(applicationData.loanAmount) || 5000000;
    const loanTerm = parseInt(applicationData.loanTerm) || 12;
    const annualRate = 0.12;
    const monthlyRate = annualRate / 12;
    
    const monthlyPayment = loanAmount * monthlyRate * Math.pow(1 + monthlyRate, loanTerm) / 
                          (Math.pow(1 + monthlyRate, loanTerm) - 1);
    const totalRepayment = monthlyPayment * loanTerm;
    
    const approvedAmountEl = document.getElementById('approvedAmount');
    const loanAmountDetailEl = document.getElementById('loanAmountDetail');
    const monthlyPaymentDetailEl = document.getElementById('monthlyPaymentDetail');
    const repaymentPeriodDetailEl = document.getElementById('repaymentPeriodDetail');
    const totalRepaymentDetailEl = document.getElementById('totalRepaymentDetail');
    
    if (approvedAmountEl) approvedAmountEl.textContent = 'TSh ' + loanAmount.toLocaleString();
    if (loanAmountDetailEl) loanAmountDetailEl.textContent = 'TSh ' + loanAmount.toLocaleString();
    if (monthlyPaymentDetailEl) monthlyPaymentDetailEl.textContent = 'TSh ' + Math.round(monthlyPayment).toLocaleString();
    if (repaymentPeriodDetailEl) repaymentPeriodDetailEl.textContent = loanTerm + ' miezi';
    if (totalRepaymentDetailEl) totalRepaymentDetailEl.textContent = 'TSh ' + Math.round(totalRepayment).toLocaleString();
    
    console.log('Approval page loaded:', { loanAmount, loanTerm, monthlyPayment: Math.round(monthlyPayment) });
    
    createConfetti();
});

function downloadAgreement() {
    const applicationData = JSON.parse(sessionStorage.getItem('applicationData') || '{}');
    const loanAmount = parseFloat(applicationData.loanAmount) || 5000000;
    const loanTerm = parseInt(applicationData.loanTerm) || 12;
    const annualRate = 0.12;
    const monthlyRate = annualRate / 12;
    
    const monthlyPayment = loanAmount * monthlyRate * Math.pow(1 + monthlyRate, loanTerm) / 
                          (Math.pow(1 + monthlyRate, loanTerm) - 1);
    const totalRepayment = monthlyPayment * loanTerm;
    
    const agreementText = `
MKATABA WA MKOPO
==================

Nambari ya Ombi: ${applicationData.applicationId || 'Hakuna'}
Tarehe: ${new Date().toLocaleDateString('sw-TZ')}

TAARIFA ZA MKOPAJI:
Jina: ${applicationData.fullName || 'Hakuna'}
Barua pepe: ${applicationData.email || 'Hakuna'}

MAELEZO YA MKOPO:
Kiasi cha Mkopo: TSh ${loanAmount.toLocaleString()}
Kiwango cha Riba: ${(annualRate * 100)}% APR
Muda wa Mkopo: ${loanTerm} miezi
Malipo ya Kila Mwezi: TSh ${Math.round(monthlyPayment).toLocaleString()}
Jumla ya Malipo: TSh ${Math.round(totalRepayment).toLocaleString()}

KUSUDI: ${applicationData.loanPurpose || 'Hakuna'}

MASHARTI NA HALI:
1. Hii ni hati ya idhini ya awali ya mkopo.
2. Idhini ya mwisho inategemea uthibitishaji wa taarifa ulizotoa.
3. Malipo ya kila mwezi yanadaiwa siku moja kila mwezi.
4. Ada za ucheleweshaji zinaweza kutumika kulingana na masharti yetu ya huduma.
5. Malipo ya mapema yanaruhusiwa bila adhabu.

Hati hii ni kwa maelezo tu na haijakubaliana.

Imetengenezwa na Mkopo wa Mixx
    `;
    
    const blob = new Blob([agreementText], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mkataba-mkopo-${applicationData.applicationId || 'rasimu'}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

function viewDashboard() {
    alert('Kipengele cha Dashibodi kinakuja hivi karibuni! Utaweza kufuatilia hali ya mkopo wako hapa.');
}

function shareOnSocial(platform) {
    const applicationData = JSON.parse(sessionStorage.getItem('applicationData') || '{}');
    const loanAmount = parseFloat(applicationData.loanAmount) || 5000000;
    const text = `Nimeidhinishwa mkopo wa TSh ${loanAmount.toLocaleString()} na Mkopo wa Mixx! 🎉`;
    const url = window.location.origin;
    let shareUrl = '';
    
    switch(platform.toLowerCase()) {
        case 'whatsapp':
            shareUrl = `https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`;
            break;
        case 'facebook':
            shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
            break;
        case 'twitter':
            shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
            break;
        case 'linkedin':
            shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
            break;
    }
    
    if (shareUrl) window.open(shareUrl, '_blank', 'width=600,height=400');
}

// Confetti in Mixx by Yas brand colors: navy + gold + white
function createConfetti() {
    const colors = ['#003580', '#FFD700', '#0047b3', '#e6c200', '#ffffff', '#002060'];
    if (!document.querySelector('.approval-card')) return;
    
    for (let i = 0; i < 60; i++) {
        setTimeout(() => {
            const confetti = document.createElement('div');
            const size = Math.random() * 8 + 6;
            confetti.style.cssText = `
                position: fixed;
                width: ${size}px;
                height: ${size}px;
                background: ${colors[Math.floor(Math.random() * colors.length)]};
                left: ${Math.random() * 100}%;
                top: -10px;
                opacity: ${Math.random() * 0.8 + 0.2};
                transform: rotate(${Math.random() * 360}deg);
                pointer-events: none;
                z-index: 9999;
                border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
            `;
            document.body.appendChild(confetti);
            
            let top = -10;
            let left = parseFloat(confetti.style.left);
            const speed = Math.random() * 3 + 2;
            const drift = (Math.random() - 0.5) * 1.5;
            
            const interval = setInterval(() => {
                top += speed;
                left += drift;
                confetti.style.top = top + 'px';
                confetti.style.left = left + '%';
                if (top > window.innerHeight) {
                    clearInterval(interval);
                    confetti.remove();
                }
            }, 20);
        }, i * 25);
    }
}
