// ============================================================
// EventPay — payment.js
// Subscription purchase page ONLY. This file never creates an
// event, spreadsheet, or Drive folder — it only takes payment for
// the plan the person picked on the Create Event flow, then hands
// control back to that flow via a redirect with paymentStatus.
//
// Reuses APP_CONFIG / api() from config.js (same helper used by
// every other page in the project) so there is exactly one Web
// App URL and one fetch pattern in the whole app.
// ============================================================

(function () {
  "use strict";

  // Plan benefits shown on this page — mirrors the plan-desc text
  // used on the Select Plan step of apply-event.html, just expanded.
  var PLAN_BENEFITS = {
    "Free": ["30-day trial", "Core features", "Community support"],
    "Premium": ["Full features", "Priority support", "Custom branding"],
    "Enterprise": ["Custom limits", "Dedicated support", "White-label branding"]
  };

  var state = {
    plan: "",
    price: 0,
    organizerEmail: "",
    organizerName: "",
    organizerPhone: "",
    returnUrl: "apply-event.html",
    gateway: null // cached getPaymentGatewaySettings response
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    readIncomingData();
    renderSummary();
    bindMethodSwitch();
    bindRazorpay();
    bindUpi();
    bindResultButtons();
    loadGatewaySettings();
  }

  // ---------------------------------------------------------
  // INCOMING DATA
  // ---------------------------------------------------------
  // Accepts either URL query params (?plan=Premium&price=1499&email=...)
  // or a JSON blob stashed in sessionStorage under "ep_pending_plan"
  // by the Create Event page before navigating here. URL params win
  // if both are present.
  function readIncomingData() {
    var qs = new URLSearchParams(window.location.search);
    var stashed = {};
    try { stashed = JSON.parse(sessionStorage.getItem("ep_pending_plan") || "{}"); } catch (e) {}

    state.plan = qs.get("plan") || stashed.plan || "Free";
    state.price = Number(qs.get("price") || stashed.price || 0);
    state.organizerEmail = qs.get("email") || stashed.organizerEmail || "";
    state.organizerName = qs.get("name") || stashed.organizerName || "";
    state.organizerPhone = qs.get("phone") || stashed.organizerPhone || "";
    state.returnUrl = qs.get("returnUrl") || stashed.returnUrl || "apply-event.html";
  }

  function renderSummary() {
    setText("planName", state.plan);
    setText("planPrice", fmtINR(state.price));

    var list = document.getElementById("benefitsList");
    list.innerHTML = "";
    (PLAN_BENEFITS[state.plan] || []).forEach(function (b) {
      var li = document.createElement("li");
      li.textContent = b;
      list.appendChild(li);
    });

    // A Free plan has nothing to pay for — skip straight back.
    if (state.plan === "Free" || state.price <= 0) {
      showToast("This plan does not require payment.");
    }
  }

  // ---------------------------------------------------------
  // METHOD SWITCH
  // ---------------------------------------------------------
  function bindMethodSwitch() {
    document.querySelectorAll('input[name="payMethod"]').forEach(function (radio) {
      radio.addEventListener("change", updateMethodBlocks);
    });
    updateMethodBlocks();
  }

  function updateMethodBlocks() {
    var method = getSelectedMethod();
    document.getElementById("razorpayBlock").classList.toggle("hidden", method !== "razorpay");
    document.getElementById("upiBlock").classList.toggle("hidden", method !== "upi");
    if (method === "upi") renderUpiBlock();
  }

  function getSelectedMethod() {
    var el = document.querySelector('input[name="payMethod"]:checked');
    return el ? el.value : "razorpay";
  }

  // ---------------------------------------------------------
  // GATEWAY SETTINGS (UPI ID, enabled flags, key_id for display)
  // ---------------------------------------------------------
  function loadGatewaySettings() {
    api("getPaymentGatewaySettings", {}, "GET").then(function (res) {
      if (res && res.success) {
        state.gateway = res.settings;
        if (getSelectedMethod() === "upi") renderUpiBlock();
      }
    }).catch(function () { /* non-fatal — UPI block shows blank fields */ });
  }

  function renderUpiBlock() {
    var upiId = (state.gateway && state.gateway.upiId) || (state.gateway && state.gateway.merchantId) || "";
    setValue("upiIdDisplay", upiId || "Not configured");
    setValue("upiAmountDisplay", fmtINR(state.price));

    var qrImg = document.getElementById("upiQrImg");
    if (upiId) {
      var upiUri = "upi://pay?pa=" + encodeURIComponent(upiId) +
        "&pn=" + encodeURIComponent("EventPay") +
        "&am=" + encodeURIComponent(String(state.price)) +
        "&cu=INR";
      qrImg.src = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(upiUri);
    }
  }

  // ---------------------------------------------------------
  // RAZORPAY FLOW
  // ---------------------------------------------------------
  function bindRazorpay() {
    document.getElementById("payNowBtn").addEventListener("click", startRazorpayPayment);
  }

 

  function verifyRazorpayPayment(response, orderId) {
    setLoading(true, "Verifying payment…");

    api("verifySubscriptionPayment", {
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_order_id: response.razorpay_order_id || orderId,
      razorpay_signature: response.razorpay_signature,
      plan: state.plan,
      amount: state.price,
      organizerEmail: state.organizerEmail
    }, "POST").then(function (res) {
      setLoading(false);

      if (res && res.success) {
        showResult(true, {
          title: "Payment Successful",
          subtitle: "Your subscription has been activated.",
          details: {
            "Plan": state.plan,
            "Amount": fmtINR(state.price),
            "Payment ID": response.razorpay_payment_id,
            "Order ID": response.razorpay_order_id || orderId
          }
        });
        stashResultForReturn({
          paymentStatus: "success",
          paymentId: response.razorpay_payment_id,
          orderId: response.razorpay_order_id || orderId,
          transactionId: response.razorpay_payment_id
        });
      } else {
        showResult(false, {
          title: "Payment Failed",
          subtitle: (res && res.message) || "Signature verification failed.",
          details: {}
        });
      }
    }).catch(function (err) {
      setLoading(false);
      showResult(false, { title: "Payment Failed", subtitle: "Error: " + err, details: {} });
    });
  }

  // ---------------------------------------------------------
  // DIRECT UPI FLOW
  // ---------------------------------------------------------
  function bindUpi() {
    document.getElementById("submitUpiBtn").addEventListener("click", submitUpiPayment);
  }

  function submitUpiPayment() {
    var utr = (document.getElementById("utrInput").value || "").trim();
    if (!utr || utr.length < 6) {
      showToast("Enter a valid UTR / transaction reference number.");
      return;
    }

    setLoading(true, "Submitting for verification…");

    api("verifySubscriptionPayment", {
      method: "upi",
      utr: utr,
      plan: state.plan,
      amount: state.price,
      organizerEmail: state.organizerEmail
    }, "POST").then(function (res) {
      setLoading(false);

      // Direct UPI is never instantly verified — it always goes to
      // manual review, regardless of what the backend returns, per
      // the required pendingVerification flow.
      showResult(true, {
        title: "Submitted for Verification",
        subtitle: "We'll confirm your payment shortly. You can continue in the meantime.",
        details: {
          "Plan": state.plan,
          "Amount": fmtINR(state.price),
          "UTR": utr
        }
      });
      stashResultForReturn({
        paymentStatus: "pendingVerification",
        paymentId: "",
        orderId: "",
        transactionId: utr
      });
    }).catch(function (err) {
      setLoading(false);
      showToast("Error: " + err);
    });
  }

  // ---------------------------------------------------------
  // RESULT SCREEN
  // ---------------------------------------------------------
  var pendingReturnParams = null;

  function stashResultForReturn(params) {
    pendingReturnParams = params;
  }

  function showResult(success, opts) {
    document.getElementById("summaryBlock").parentElement.querySelectorAll(".pay-section").forEach(function (s) {
      if (s.id !== "resultBlock") s.classList.add("hidden");
    });

    var block = document.getElementById("resultBlock");
    block.classList.remove("hidden");

    var icon = document.getElementById("resultIcon");
    icon.textContent = success ? "✓" : "✕";
    icon.classList.toggle("failed", !success);

    setText("resultTitle", opts.title);
    setText("resultSubtitle", opts.subtitle);

    var detailsEl = document.getElementById("resultDetails");
    detailsEl.innerHTML = "";
    Object.keys(opts.details || {}).forEach(function (key) {
      var row = document.createElement("div");
      row.className = "result-row";
      row.innerHTML = "<span>" + key + "</span><span>" + opts.details[key] + "</span>";
      detailsEl.appendChild(row);
    });

    document.getElementById("retryBtn").classList.toggle("hidden", success);
    document.getElementById("backBtn").classList.toggle("hidden", success);
    document.getElementById("continueBtn").classList.toggle("hidden", !success);
  }

  // Uses state.returnUrl (the page that sent us here, e.g. apply-event.html)
  // instead of a hardcoded page, and appends the paymentStatus (plus any
  // transaction details) so the return page can resume the correct branch
  // of the flow (success / pendingVerification / failed).
  function bindResultButtons() {
    document.getElementById("retryBtn").addEventListener("click", function () {
      window.location.reload();
    });

    document.getElementById("backBtn").addEventListener("click", function () {
      window.location.href = state.returnUrl + "?paymentStatus=failed";
    });

    document.getElementById("continueBtn").addEventListener("click", function () {
      var target = state.returnUrl;
      if (pendingReturnParams) {
        var qs = new URLSearchParams(pendingReturnParams);
        target += "?" + qs.toString();
      }
      window.location.href = target;
    });
  }

  // ---------------------------------------------------------
  // UTILITIES (mirrors apply-event.js helpers, kept local so this
  // page has zero dependency on apply-event.js)
  // ---------------------------------------------------------
  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function setValue(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val;
  }
  function fmtINR(n) {
    return "₹" + Number(n || 0).toLocaleString("en-IN");
  }
  function showToast(message) {
    var toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.classList.add("hidden"); }, 3500);
  }
  function setLoading(isLoading, text) {
    var overlay = document.getElementById("loadingOverlay");
    if (isLoading) {
      setText("loadingText", text || "Working…");
      overlay.classList.remove("hidden");
    } else {
      overlay.classList.add("hidden");
    }
  }

})();
