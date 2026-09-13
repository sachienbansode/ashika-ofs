'use strict';
/**
 * Pinch-zoom and double-tap-zoom, switched off.
 *
 * Asked for by the desk. Worth writing down why it takes more than a meta tag:
 *
 *   user-scalable=no and maximum-scale=1 work on Android, and iOS Safari has
 *   IGNORED both since iOS 10 — precisely because sites used them this way. So the
 *   meta tag alone changes nothing on an iPhone, which is where this was reported.
 *
 *   What iOS does still honour is the gesture events. Cancelling gesturestart
 *   stops the pinch before it begins; cancelling a touchmove that has two or more
 *   fingers on it stops the rest. Neither affects one-finger scrolling.
 *
 *   Double-tap-to-zoom is separate again, and is handled by touch-action:
 *   manipulation in theme.css — the CSS way, which also removes the 300ms click
 *   delay that used to come with it.
 *
 * Deliberately does NOT touch ctrl+wheel or the browser's own page zoom: those are
 * a person deliberately changing text size on a desktop, which is a different thing
 * from a phone zooming because a thumb brushed the screen.
 *
 * One consequence to be aware of: an investor who needs to magnify text to read it
 * can no longer do so inside the page. The 16px minimum on every control and the
 * page's own type sizes are what has to carry that instead.
 */
(function () {
  var stop = function (e) { e.preventDefault(); };

  // iOS Safari. These fire only for a pinch, never for a scroll.
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('gestureend', stop, { passive: false });

  // Everything else, and iOS once a pinch is already running. One finger is a
  // scroll and must go through untouched; two or more is a pinch.
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  /* Double-tap. touch-action:manipulation covers it on every current browser, but
   * an older iOS still zooms on a second tap inside 300ms, and the cost of closing
   * that is one timestamp. A tap on a form control is left alone: the keyboard
   * opening must not be delayed or swallowed. */
  var lastTap = 0;
  document.addEventListener('touchend', function (e) {
    var now = Date.now();
    var t = e.target;
    var interactive = t && t.closest &&
      t.closest('input, select, textarea, button, a, [contenteditable]');
    if (!interactive && now - lastTap < 300) e.preventDefault();
    lastTap = now;
  }, { passive: false });
}());
