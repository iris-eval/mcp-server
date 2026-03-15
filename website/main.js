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
  { threshold: 0.15 }
);

document.querySelectorAll('.reveal-up, .reveal-left, .reveal-right').forEach((el) => {
  revealObserver.observe(el);
});

// ===== Dashboard Mockup Animation =====
const dashboardMockup = document.querySelector('.dashboard-mockup');
if (dashboardMockup) {
  const dashObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          dashboardMockup.classList.add('animated');
          animateCounters();
          dashObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.3 }
  );
  dashObserver.observe(dashboardMockup);
}

// ===== Counter Animation =====
function animateCounters() {
  // Integer counter
  document.querySelectorAll('[data-count]').forEach((el) => {
    const target = parseInt(el.dataset.count, 10);
    animateValue(el, 0, target, 1200, (v) => v.toLocaleString());
  });

  // Decimal counter (scores)
  document.querySelectorAll('[data-count-decimal]').forEach((el) => {
    const target = parseFloat(el.dataset.countDecimal);
    animateValue(el, 0, target, 1200, (v) => v.toFixed(2));
  });

  // Percentage counter
  document.querySelectorAll('[data-count-pct]').forEach((el) => {
    const target = parseInt(el.dataset.countPct, 10);
    animateValue(el, 0, target, 1200, (v) => Math.round(v) + '%');
  });

  // Cost counter
  document.querySelectorAll('[data-count-cost]').forEach((el) => {
    const target = parseFloat(el.dataset.countCost);
    animateValue(el, 0, target, 1200, (v) => '$' + v.toFixed(2));
  });
}

function animateValue(el, start, end, duration, formatter) {
  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (end - start) * eased;
    el.textContent = formatter(current);
    if (progress < 1) {
      requestAnimationFrame(step);
    }
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

document.querySelectorAll('.code-copy').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.copy;
    const text = copyTexts[key];
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      const copyIcon = btn.querySelector('.code-copy-icon');
      const checkIcon = btn.querySelector('.code-check-icon');
      if (copyIcon) copyIcon.style.display = 'none';
      if (checkIcon) checkIcon.style.display = 'block';

      setTimeout(() => {
        btn.classList.remove('copied');
        if (copyIcon) copyIcon.style.display = 'block';
        if (checkIcon) checkIcon.style.display = 'none';
      }, 2000);
    });
  });
});

// ===== Waitlist Form =====
const waitlistForm = document.getElementById('waitlist-form');
const waitlistSuccess = document.getElementById('waitlist-success');

if (waitlistForm) {
  waitlistForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = waitlistForm.querySelector('input[type="email"]');
    const submitBtn = waitlistForm.querySelector('button[type="submit"]');
    const email = emailInput.value.trim();

    if (!email) return;

    // Disable button during submission
    submitBtn.disabled = true;
    submitBtn.textContent = 'Joining...';

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (res.ok) {
        waitlistForm.style.display = 'none';
        waitlistSuccess.style.display = 'flex';
      } else {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) {
          submitBtn.textContent = 'Too many attempts';
        } else {
          submitBtn.textContent = data.error || 'Something went wrong';
        }
        setTimeout(() => {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Get Early Access';
        }, 3000);
      }
    } catch {
      // Network error — fall back to localStorage
      const waitlist = JSON.parse(localStorage.getItem('iris-waitlist') || '[]');
      if (!waitlist.includes(email)) {
        waitlist.push(email);
        localStorage.setItem('iris-waitlist', JSON.stringify(waitlist));
      }
      waitlistForm.style.display = 'none';
      waitlistSuccess.style.display = 'flex';
    }
  });
}

// ===== Fetch Waitlist Count (social proof) =====
(async function loadWaitlistCount() {
  try {
    const res = await fetch('/api/waitlist-count');
    if (res.ok) {
      const { count } = await res.json();
      if (count > 0) {
        const note = document.querySelector('.waitlist-note');
        if (note) {
          note.textContent = `${count} developer${count === 1 ? '' : 's'} on the waitlist. No spam.`;
        }
      }
    }
  } catch {
    // Silently fail — count is a nice-to-have
  }
})();

// ===== Smooth scroll for anchor links =====
document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    const target = document.querySelector(anchor.getAttribute('href'));
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});
