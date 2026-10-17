/* Ludo Master 3D — "Download App" (PWA install).
 *
 * Shows a Download App button on the home screen. Tapping it triggers the
 * native install prompt when the browser offers one (Chrome/Edge Android);
 * otherwise it opens a modal with manual steps (Add to Home Screen).
 * Standalone, dependency-free; safe to load on any page.
 */
(function () {
  'use strict';

  var deferredPrompt = null;
  var btn = document.getElementById('download-app-btn');
  var modal = document.getElementById('modal-install');
  var stepsBox = document.getElementById('install-steps');

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true ||
      (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== '')
    );
  }

  function isIOS() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  }

  function openModal() { if (modal) modal.hidden = false; }
  function closeModal() { if (modal) modal.hidden = true; }

  function fillSteps() {
    if (!stepsBox) return;
    var steps;
    if (isIOS()) {
      steps = [
        t('install.ios1'),
        t('install.ios2'),
        t('install.ios3'),
      ];
    } else {
      steps = [
        t('install.and1'),
        t('install.and2'),
        t('install.and3'),
      ];
    }
    stepsBox.innerHTML =
      '<ol>' + steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>';
  }

  // Browser signals that the app is installable -> remember the prompt.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });

  document.addEventListener('DOMContentLoaded', function () {
    btn = document.getElementById('download-app-btn');
    modal = document.getElementById('modal-install');
    stepsBox = document.getElementById('install-steps');
    fillSteps();

    // Hide the button when already running as an installed app / in Telegram.
    if (btn && isStandalone()) btn.hidden = true;

    if (btn) {
      btn.addEventListener('click', function () {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function () {
            deferredPrompt = null;
            btn.hidden = true;
          }).catch(function () { /* dismissed */ });
        } else {
          fillSteps();
          openModal();
        }
      });
    }

    // data-close buttons inside the modal
    if (modal) {
      modal.querySelectorAll('[data-close]').forEach(function (el) {
        el.addEventListener('click', closeModal);
      });
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeModal();
      });
    }

    // If installed while page open, hide the button.
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      if (btn) btn.hidden = true;
    });
  });
})();
