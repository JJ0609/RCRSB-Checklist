// ─────────────────────────────────────────────────────────────
// Login — email only, no password. This is identity capture and
// project-visibility filtering, not real access control: anyone can
// type any email, including someone else's. It exists so every check,
// punch item, and export shows a real name instead of "Unnamed tech",
// and so the project picker only shows what's relevant to that email.
//
// Two-step flow: choose AV or LC first, then the email step appears,
// scoped to whichever side was picked. Projects themselves aren't
// separate per side (see projects.js/app.js), only their device lists,
// locations, and checklist status are. The choice is stored alongside
// the email and carried through every page from here on; switching
// sides later goes through the topbar switcher (see app.js), not back
// through this page.
// ─────────────────────────────────────────────────────────────

function isLikelyEmail(v){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

function safeRedirectTarget(raw){
    const fallback = 'projects.html';
    if(!raw) return fallback;
    //Only allow a bare filename (+ optional query string) within this site
    //Never follow an absolute URL or protocol-relative address to avoid an open redirect
    if(/^[a-z0-9_-]+\.html(\?[^\s]*)?$/i.test(raw)) return raw;
    return fallback;
}

let chosenDeviceType = null;

function showEmailStep(deviceType){
    chosenDeviceType = deviceType;
    document.getElementById('chosenModeLabel').textContent = deviceType === 'lc' ? 'LC Projects' : 'AV Projects';
    document.getElementById('modeChoice').hidden = true;
    document.getElementById('emailStep').hidden = false;
    document.getElementById('emailInput').focus();
}

function showModeChoice(){
    chosenDeviceType = null;
    document.getElementById('modeChoice').hidden = false;
    document.getElementById('emailStep').hidden = true;
    document.getElementById('emailInput'). value = '';
    document.getElementById('loginMsg').textContent = '';
}

function submitLogin(){
    const msgE1 = document.getElementById('loginMsg');
    if(!chosenDeviceType){ showModeChoice(); return; }
    const email = document.getElementById('emailInput').value.trim().toLowerCase();
    if(!isLikelyEmail(email)){
        msgE1.textContent = 'Enter a valid email address.';
        return;
    }
    try{
        sessionStorage.setItem('pd_user_email', email);
        sessionStorage.setItem('pd_tech_name', email);
        sessionStorage.setItem('pd_device_type', chosenDeviceType);
    }catch(e){}

    const params = new URLSearchParams(window.location.search);
    window.location.href = safeRedirectTarget(params.get('redirect'));
}

document.getElementById('chooseAvBtn').addEventListener('click', function(){showEmailStep('av'); });
document.getElementById('chooseLcBtn').addEventListener('click', function(){showEmailStep('lc'); });
document.getElementById('changeModeBtn').addEventListener('click', showModeChoice);
document.getElementById('emailSubmit').addEventListener('click', submitLogin);
document.getElementById('emailInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter') submitLogin();
});

//If someone is already logged in AND Already has a side chosen and lands
//on login.html directly(e.g. a bookmark) just move them along instead
//of asking again. An email with no device_type yet (e.g. a session from
//before AV/LC existed) is NOT treated as fully logged in — this page
//still shows so they can pick a side.
(function(){
    try{
        if(sessionStorage.getItem('pd_user_email') && sessionStorage.getItem('pd_device_type')){
            const params = new URLSearchParams(window.location.search);
            window.location.replace(safeRedirectTarget(params.get('redirect')));
        }
    }catch(e){}
})();