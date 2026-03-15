// ===== Scroll Reveal =====
const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 }
);
document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

// ===== Hero Word Swap =====
const swapEl = document.getElementById('hero-swap');
if (swapEl) {
  const words = ['actually doing.', 'actually costing.', 'actually leaking.'];
  let idx = 0;
  setInterval(() => {
    swapEl.style.opacity = '0';
    swapEl.style.transform = 'translateY(8px)';
    setTimeout(() => {
      idx = (idx + 1) % words.length;
      swapEl.textContent = words[idx];
      swapEl.style.opacity = '1';
      swapEl.style.transform = 'translateY(0)';
    }, 300);
  }, 3000);
}

// ===== Product Tabs =====
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ===== Stat Counters =====
const counterObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const target = parseInt(el.dataset.count, 10);
        if (isNaN(target)) return;
        animateCount(el, 0, target, 1000);
        counterObserver.unobserve(el);
      }
    });
  },
  { threshold: 0.5 }
);
document.querySelectorAll('[data-count]').forEach((el) => counterObserver.observe(el));

function animateCount(el, start, end, duration) {
  const t0 = performance.now();
  function step(now) {
    const p = Math.min((now - t0) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(start + (end - start) * eased).toLocaleString();
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ===== Copy Buttons =====
const copyTexts = {
  config: `{
  "mcpServers": {
    "iris-eval": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server"]
    }
  }
}`,
  install: `npm install -g @iris-eval/mcp-server\niris-mcp --dashboard`,
};

document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const text = copyTexts[btn.dataset.copy];
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      const ci = btn.querySelector('.copy-icon');
      const ch = btn.querySelector('.check-icon');
      if (ci) ci.style.display = 'none';
      if (ch) ch.style.display = 'block';
      setTimeout(() => {
        btn.classList.remove('copied');
        if (ci) ci.style.display = 'block';
        if (ch) ch.style.display = 'none';
      }, 2000);
    });
  });
});

// ===== Waitlist Form =====
const waitlistForm = document.getElementById('waitlist-form');
const waitlistOk = document.getElementById('waitlist-ok');

if (waitlistForm) {
  waitlistForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = waitlistForm.querySelector('input[type="email"]');
    const btn = waitlistForm.querySelector('button[type="submit"]');
    const email = input.value.trim();
    if (!email) return;

    btn.disabled = true;
    btn.textContent = 'Joining...';

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        waitlistForm.style.display = 'none';
        waitlistOk.style.display = 'flex';
      } else {
        const data = await res.json().catch(() => ({}));
        btn.textContent = res.status === 429 ? 'Too many attempts' : data.error || 'Something went wrong';
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = 'Get Early Access';
        }, 3000);
      }
    } catch {
      // Fallback to localStorage
      const list = JSON.parse(localStorage.getItem('iris-waitlist') || '[]');
      if (!list.includes(email)) {
        list.push(email);
        localStorage.setItem('iris-waitlist', JSON.stringify(list));
      }
      waitlistForm.style.display = 'none';
      waitlistOk.style.display = 'flex';
    }
  });
}

// ===== Waitlist Count =====
(async function () {
  try {
    const res = await fetch('/api/waitlist-count');
    if (res.ok) {
      const { count } = await res.json();
      if (count > 0) {
        const note = document.getElementById('waitlist-note');
        if (note) note.textContent = `${count} developer${count === 1 ? '' : 's'} on the waitlist. No spam.`;
      }
    }
  } catch {}
})();

// ===== Smooth Scroll =====
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const t = document.querySelector(a.getAttribute('href'));
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// ===== Nav Background on Scroll =====
const nav = document.getElementById('nav');
if (nav) {
  window.addEventListener('scroll', () => {
    nav.style.background = window.scrollY > 60
      ? 'rgba(3,7,18,.92)'
      : 'rgba(3,7,18,.75)';
  }, { passive: true });
}
