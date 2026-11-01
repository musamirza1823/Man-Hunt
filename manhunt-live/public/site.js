/*
 * Landing page motion: text and images come out of the dark as you scroll,
 * the hero and the scene pictures drift (parallax), the nav darkens once you
 * scroll, and a red line on the left fills as you go down the page.
 */
(() => {
  'use strict';
  const root = document.documentElement;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('js');

  const home = document.getElementById('home');
  const nav = document.getElementById('site-nav');
  const progress = document.getElementById('scroll-progress');
  const drifting = [...document.querySelectorAll('[data-parallax]')];
  const scenes = [...document.querySelectorAll('.feature-art img')];

  // ---- fade up out of the dark when scrolled into view
  const targets = document.querySelectorAll('.reveal, .reveal-group');
  if ('IntersectionObserver' in window && !reduce) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.16, rootMargin: '0px 0px -6% 0px' });
    targets.forEach((el) => io.observe(el));
  } else {
    targets.forEach((el) => el.classList.add('in'));
  }

  // ---- scroll-linked effects
  let queued = false;
  function update() {
    queued = false;
    if (home.hidden) return;
    const y = window.scrollY;
    const max = root.scrollHeight - window.innerHeight;
    nav.classList.toggle('scrolled', y > 30);
    progress.style.transform = `scaleY(${max > 0 ? Math.min(1, y / max) : 0})`;
    if (reduce) return;
    drifting.forEach((el) => {
      el.style.transform = `translate3d(0, ${(y * Number(el.dataset.parallax || 0.3)).toFixed(1)}px, 0)`;
    });
    const vh = window.innerHeight;
    scenes.forEach((img) => {
      const r = img.parentElement.getBoundingClientRect();
      if (r.bottom < -100 || r.top > vh + 100) return;
      const offset = (r.top + r.height / 2 - vh / 2) / vh;
      img.style.transform = `translate3d(0, ${(offset * -46).toFixed(1)}px, 0) scale(1.16)`;
    });
  }
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  update();

  // ---- invite links (?code=...) jump straight to the join section
  if (new URLSearchParams(location.search).get('code')) {
    setTimeout(() => {
      if (!home.hidden) document.getElementById('enter').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    }, 350);
  }
})();
