'use strict';
/**
 * Desk sign-in. Two steps, because a role may require a one-time code:
 *   POST /auth/staff/login  -> session, or { mfa_required, ref }
 *   POST /auth/staff/verify -> session
 * The session is an httpOnly cookie; nothing sensitive is kept in this page.
 */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var STATE = { ref: null };

  function show(el, on) { el.classList[on ? 'remove' : 'add']('hide'); }
  function fail(el, msg) { el.textContent = msg; show(el, true); }

  async function post(url, body) {
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    });
    var data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      var err = new Error(data.message || 'Sign-in failed.');
      err.code = data.error; err.status = r.status;
      throw err;
    }
    return data;
  }

  function busy(btn, on, label) {
    btn.disabled = on;
    btn.textContent = on ? label : btn.dataset.label;
  }

  /* ---- the portal is the preferred door; show it when one is configured ---- */
  var portal = (window.OFS_PORTAL_URL || '').trim();
  if (portal) {
    var a = $('#portalLink');
    a.href = portal.replace(/\/+$/, '') + '/api/sso/ofs';
    show(a, true);
    show($('#portalNote'), false);
  }

  /* ---- why we are here, if the desk sent us ---- */
  var reason = new URLSearchParams(location.search).get('reason');
  if (reason === 'superseded') {
    fail($('#notice'), 'This account signed in somewhere else, so the previous desk session ended. Sign in again to continue.');
    show($('#notice'), true);
  }

  $('#reveal').addEventListener('click', function () {
    var p = $('#password');
    var showing = p.type === 'text';
    p.type = showing ? 'password' : 'text';
    this.textContent = showing ? 'Show' : 'Hide';
    this.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    p.focus();
  });

  $('#signIn').dataset.label = 'Sign in';
  $('#verify').dataset.label = 'Verify & continue';

  $('#paneCreds').addEventListener('submit', async function (e) {
    e.preventDefault();
    show($('#credErr'), false);
    var email = $('#email').value.trim();
    var password = $('#password').value;
    if (!email || !password) return fail($('#credErr'), 'Enter your email and password.');

    busy($('#signIn'), true, 'Signing in…');
    try {
      var out = await post('/auth/staff/login', { email: email, password: password });
      if (out.mfa_required) {
        STATE.ref = out.ref;
        $('#sentTo').textContent = out.sent_to || 'your email';
        if (out.test_mode) {
          $('#testCode').innerHTML = 'Test environment — no email was sent. Your code is <b>' +
            String(out.test_code).replace(/[^0-9]/g, '') + '</b>.';
          show($('#testCode'), true);
        }
        show($('#paneCreds'), false);
        show($('#paneOtp'), true);
        $('#lgSub').textContent = 'One more step.';
        $('#code').focus();
        return;
      }
      location.replace('/desk/');
    } catch (err) {
      fail($('#credErr'), err.message);
      $('#password').select();
    } finally {
      busy($('#signIn'), false);
    }
  });

  $('#code').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 6);
    show($('#otpErr'), false);
  });

  $('#paneOtp').addEventListener('submit', async function (e) {
    e.preventDefault();
    var code = $('#code').value.trim();
    if (code.length !== 6) return fail($('#otpErr'), 'Enter the 6-digit code.');

    busy($('#verify'), true, 'Verifying…');
    try {
      await post('/auth/staff/verify', { ref: STATE.ref, code: code });
      location.replace('/desk/');
    } catch (err) {
      fail($('#otpErr'), err.message);
      // A dead challenge cannot be retried — send them back rather than letting
      // them type into a form that can no longer succeed.
      if (['unknown', 'used', 'expired', 'too_many_attempts'].indexOf(err.code) >= 0) {
        setTimeout(function () { location.replace('/desk/login.html'); }, 2200);
      }
      $('#code').select();
    } finally {
      busy($('#verify'), false);
    }
  });

  $('#startOver').addEventListener('click', function () { location.replace('/desk/login.html'); });
})();
