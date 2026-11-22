export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Non-blocking toast banner (replaces alert() across the app)
export function notify(message, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:8px;max-width:360px;";
    document.body.appendChild(container);
  }

  const colors = {
    success: "background:#16a34a;color:#fff;",
    error: "background:#dc2626;color:#fff;",
    warning: "background:#d97706;color:#fff;",
    info: "background:#0f172a;color:#fff;"
  };

  const toast = document.createElement("div");
  toast.style.cssText = `${colors[type] || colors.info}padding:12px 16px;border-radius:10px;font-size:14px;font-weight:500;box-shadow:0 10px 15px -3px rgba(0,0,0,0.2);transition:opacity 0.25s;`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 250);
  }, 3800);
}

// Consistent button loading state wrapper
export async function withLoading(button, loadingLabel, operation) {
  if (!button) return operation();
  if (button.disabled) return null;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = loadingLabel;

  try {
    return await operation();
  } catch (err) {
    notify(err.message || "An unexpected error occurred.", "error");
    throw err;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

// Consistent Local Date & Deadline Helpers
export function getTodayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDeadline(isoStr) {
  if (!isoStr) return new Date();
  return new Date(isoStr);
}

export function formatDueDate(isoStr) {
  return parseLocalDeadline(isoStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function isPastDeadline(dueDateStr, graceHours = 0) {
  const dueMs = parseLocalDeadline(dueDateStr).getTime() + graceHours * 3600 * 1000;
  return Date.now() > dueMs;
}

// Strict File Validation before Cloudinary upload
export function validateImageFiles(fileList, { maxFiles = 8, maxSizeMB = 10 } = {}) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return { valid: false, error: "Please select at least one image." };
  if (files.length > maxFiles) {
    return { valid: false, error: `Maximum ${maxFiles} images allowed per submission.` };
  }

  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  for (const f of files) {
    if (!allowedTypes.includes(f.type)) {
      return { valid: false, error: `Unsupported file type: ${f.name}. Use JPG, PNG, or WEBP.` };
    }
    if (f.size > maxSizeMB * 1024 * 1024) {
      return { valid: false, error: `${f.name} exceeds the ${maxSizeMB}MB size limit.` };
    }
  }
  return { valid: true, files };
}
