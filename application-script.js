// Application Form Script - Mkopo wa Mixx
// ✅ Admin ID is now handled entirely server-side via cookie session.
// Frontend never reads, stores, or sends adminId — the cookie does it automatically.

document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('applicationForm');
    if (!form) { console.error('Application form not found!'); return; }

    // Error container
    const errorContainer = document.createElement('div');
    errorContainer.style.cssText = 'display:none; background:#fee2e2; border:2px solid #fecaca; color:#991b1b; padding:16px 20px; border-radius:12px; margin:20px 0; font-size:15px;';
    form.insertBefore(errorContainer, form.firstChild);

    function showErrors(errors) {
        if (!errors.length) { errorContainer.style.display = 'none'; return; }
        errorContainer.innerHTML = '<strong style="display:block;margin-bottom:8px;">⚠ Tafadhali sahihisha:</strong><ul style="margin:8px 0 0 20px;padding:0;">' +
            errors.map(e => `<li style="margin:4px 0;">${e}</li>`).join('') + '</ul>';
        errorContainer.style.display = 'block';
        errorContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Real-time validation
    const inputs = form.querySelectorAll('input, select, textarea');
    inputs.forEach(input => { input.addEventListener('blur', () => validateField(input)); });

    form.addEventListener('submit', function(e) {
        e.preventDefault();
        let isValid = true;
        const errors = [];
        inputs.forEach(input => {
            if (!validateField(input)) {
                isValid = false;
                const label = input.previousElementSibling?.textContent || input.name || 'Field';
                errors.push(`${label.trim()}: Taarifa sio sahihi`);
            }
        });
        if (!isValid) { showErrors(errors); return; }
        errorContainer.style.display = 'none';

        // ✅ Collect form data — NO adminId here, server reads it from cookie
        const formData = {
            fullName: document.getElementById('fullName')?.value?.trim(),
            email: document.getElementById('email')?.value?.trim(),
            monthlyIncome: document.getElementById('monthlyIncome')?.value,
            loanAmount: document.getElementById('loanAmount')?.value,
            loanPurpose: document.getElementById('loanPurpose')?.value,
            loanTerm: document.getElementById('repaymentPeriod')?.value,
            employmentStatus: document.getElementById('employmentStatus')?.value,
            applicationId: 'LOAN-' + Date.now(),
            submittedAt: new Date().toISOString()
        };

        sessionStorage.setItem('applicationData', JSON.stringify(formData));
        console.log('📋 Application saved — admin assigned server-side via session');
        window.location.href = 'verification.html';
    });

    function validateField(field) {
        const value = field.value.trim();
        field.classList.remove('error');
        if (field.hasAttribute('required') && !value) { field.classList.add('error'); return false; }
        if (field.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { field.classList.add('error'); return false; }
        if (field.type === 'number' && value) {
            const num = parseFloat(value);
            const min = parseFloat(field.getAttribute('min'));
            const max = parseFloat(field.getAttribute('max'));
            if ((min && num < min) || (max && num > max)) { field.classList.add('error'); return false; }
        }
        return true;
    }

    const style = document.createElement('style');
    style.textContent = 'input.error, select.error, textarea.error { border-color: #ef4444 !important; background-color: #fef2f2 !important; }';
    document.head.appendChild(style);
});
