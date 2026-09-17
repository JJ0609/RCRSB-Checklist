// ─────────────────────────────────────────────────────────────
// Login — email only, no password. This is identity capture and
// project-visibility filtering, not real access control: anyone can
// type any email, including someone else's. It exists so every check,
// punch item, and export shows a real name instead of "Unnamed tech",
// and so the project picker only shows what's relevant to that email.
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

function submitLogin(){
    const msgE1 = document.getElementById('loginMsg');
    const email = document.getElementById('emailInput').value.trim().toLowerCase();
    if(!isLikelyEmail(email)){
        msgE1.textContent = 'Enter a valid email address.';
        return;
    }
    try{
        sessionStorage.setItem('pd_user_email', email);
        sessionStorage.setItem('pd_tech_name', email);
    }catch(e){}

    const params = new URLSearchParams(window.location.search);
    window.location.href = safeRedirectTarget(params.get('redirect'));
}

document.getElementById('emailSubmit').addEventListener('click', submitLogin);
document.getElementById('emailInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter') submitLogin();
});

//If someone is already logged in and lands on login.html directly
//(e.g. a bookmark) just move them along instead of asking again

(function(){
    try{
        if(sessionStorage.getItem('pd_user_email')){
            const params = new URLSearchParams(window.location.search);
            window.location.replace(safeRedirectTarget(params.get('redirect')));
        }
    }catch(e){}
});