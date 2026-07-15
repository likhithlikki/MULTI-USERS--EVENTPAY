(function () {
  "use strict";

  var state = {
    currentStep: 1,
    totalSteps: 5,
    otpVerified: false,
    duplicateAcknowledged: false,
    eventStatus: null // "Active" (free / razorpay success) or "Inactive" (UPI pending), set at Step 2 / on payment return
  };

  var PLAN_PRICES = { "Free": 0, "Premium": 1499, "Enterprise": 4999 };

  var DYNAMIC_FIELDS = {
    "Marriage": [
      { id: "brideName", label: "Bride Name", type: "text" },
      { id: "groomName", label: "Groom Name", type: "text" }
    ],
    "Reception": [
      { id: "brideName", label: "Bride Name", type: "text" },
      { id: "groomName", label: "Groom Name", type: "text" }
    ],
    "Engagement": [
      { id: "brideName", label: "Bride Name", type: "text" },
      { id: "groomName", label: "Groom Name", type: "text" }
    ],
    "Birthday": [
      { id: "birthdayPersonName", label: "Birthday Person Name", type: "text" }
    ],
    "House Warming": [
      { id: "familyName", label: "Family Name", type: "text" }
    ],
    "Temple Festival": [
      { id: "templeName", label: "Temple Name", type: "text" }
    ],
    "Corporate Event": [
      { id: "companyName", label: "Company Name", type: "text" }
    ],
    "Other": [
      { id: "customEventName", label: "Custom Event Name", type: "text" }
    ],
    "Anniversary": [],
    "Baby Shower": []
  };

  document.addEventListener("DOMContentLoaded", init);

function init() {
  bindNav();
  bindOtp();
  bindEventTypeChange();
  bindPlanSelection();
  bindSubmit();
  bindResultButtons();

  var resumed = handlePaymentReturn();

  if (!resumed) {
    goToStep(1);
  }
}

  // ---------------------------------------------------------
  // STEP NAVIGATION
  // ---------------------------------------------------------

  function bindNav() {
    document.querySelectorAll("[data-next]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (validateStep(state.currentStep)) {
          goToStep(state.currentStep + 1);
        }
      });
    });
    document.querySelectorAll("[data-prev]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        goToStep(state.currentStep - 1);
      });
    });
  }

  function goToStep(step) {
    if (step < 1 || step > state.totalSteps) return;
    state.currentStep = step;

    document.querySelectorAll(".step-card").forEach(function (card) {
      card.classList.toggle("active", Number(card.dataset.step) === step);
    });
    document.querySelectorAll(".step-dot").forEach(function (dot) {
      dot.classList.toggle("active", Number(dot.dataset.step) <= step);
    });

    if (step === 2) {
      updatePlanContinueBtn();
    }

    if (step === 4) {
      renderDynamicFields(getSelectedEventType());
    }
  }

  function validateStep(step) {
    if (step === 1) {
      var name = val("organizerName");
      var phone = val("organizerPhone");
      var email = val("organizerEmail");

      if (!name || !phone || !email) {
        showToast("Please fill in all organizer details.");
        return false;
      }
      if (!/^\d{10}$/.test(phone)) {
        showToast("Enter a valid 10-digit phone number.");
        return false;
      }
      if (!state.otpVerified) {
        showToast("Please verify your email with OTP before continuing.");
        return false;
      }
      return true;
    }

    // Step 2 no longer uses [data-next] — it has its own
    // planContinueBtn / handlePlanContinueClick flow below.

    if (step === 3) {
      if (!getSelectedEventType()) {
        showToast("Please select an event type.");
        return false;
      }
      return true;
    }

    return true;
  }

  // ---------------------------------------------------------
  // OTP
  // ---------------------------------------------------------

  function bindOtp() {
    document.getElementById("sendOtpBtn").addEventListener("click", function () {
      var email = val("organizerEmail");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showToast("Enter a valid email first.");
        return;
      }

      setLoading(true, "Sending OTP…");
      runServer("sendOrganizerOtp", { email: email })
        .then(function (res) {
          setLoading(false);
          if (res.success) {
            document.getElementById("otpBlock").classList.remove("hidden");
            setText("otpStatus", "OTP sent. Check your inbox.");
            showToast("OTP sent to " + email);
          } else {
            showToast(res.message || "Failed to send OTP.");
          }
        })
        .catch(function (err) {
          setLoading(false);
          console.error(err);
          alert(err && err.stack ? err.stack : JSON.stringify(err, null, 2));
          showToast("Error: " + err);
        });
    });

    document.getElementById("verifyOtpBtn").addEventListener("click", function () {
      var email = val("organizerEmail");
      var otp = val("otpInput");
      if (!otp || otp.length !== 6) {
        showToast("Enter the 6-digit OTP.");
        return;
      }

      setLoading(true, "Verifying…");
      runServer("verifyOrganizerOtp", { email: email, otp: otp })
        .then(function (res) {
          setLoading(false);
          if (res.success) {
            state.otpVerified = true;
            setText("otpStatus", "✓ Email verified.");
            showToast("Email verified.");
          } else {
            showToast(res.message || "Invalid OTP.");
          }
        })
        .catch(function (err) {
          setLoading(false);
          console.error(err);
          alert(err && err.stack ? err.stack : JSON.stringify(err, null, 2));
          showToast("Error: " + err);
        });
    });
  }

  // ---------------------------------------------------------
  // PLAN SELECTION (STEP 2)
  // ---------------------------------------------------------
  //
  // Single button (#planContinueBtn) drives everything:
  //  - no plan checked   -> disabled, "Select a Plan"
  //  - Free checked      -> enabled, "Continue"      -> goToStep(3), no payment
  //  - Premium checked   -> enabled, "Pay ₹1499"      -> proceedToPayment()
  //  - Enterprise checked-> enabled, "Pay ₹4999"      -> proceedToPayment()
  // ---------------------------------------------------------

  function bindPlanSelection() {
    document.querySelectorAll('input[name="plan"]').forEach(function (radio) {
      radio.addEventListener("change", updatePlanContinueBtn);
    });
    document.getElementById("planContinueBtn").addEventListener("click", handlePlanContinueClick);
    updatePlanContinueBtn();
  }

  function updatePlanContinueBtn() {
    var btn = document.getElementById("planContinueBtn");
    if (!btn) return;

    var plan = getSelectedPlan();

    if (!plan) {
      btn.disabled = true;
      btn.textContent = "Select a Plan";
      return;
    }

    var price = PLAN_PRICES[plan] || 0;
    btn.disabled = false;
    btn.textContent = price > 0 ? ("Pay \u20B9" + price) : "Continue";
  }

  function handlePlanContinueClick() {
    var plan = getSelectedPlan();
    if (!plan) return;

    var price = PLAN_PRICES[plan] || 0;

    if (price <= 0) {
      state.eventStatus = "Active"; // Free plan — unchanged existing behavior, no payment
      goToStep(3);
      return;
    }

    proceedToPayment(plan, price);
  }

  function resetPlanSelection() {
    document.querySelectorAll('input[name="plan"]').forEach(function (r) {
      r.checked = false;
    });
    updatePlanContinueBtn();
  }

  // ---------------------------------------------------------
  // DYNAMIC FIELDS
  // ---------------------------------------------------------

  function bindEventTypeChange() {
    document.querySelectorAll('input[name="eventType"]').forEach(function (radio) {
      radio.addEventListener("change", function () {
        renderDynamicFields(getSelectedEventType());
      });
    });
  }

  function renderDynamicFields(eventType) {
    var container = document.getElementById("dynamicFields");
    container.innerHTML = "";
    var fields = DYNAMIC_FIELDS[eventType] || [];

    fields.forEach(function (field) {
      var label = document.createElement("label");
      label.textContent = field.label;

      var input = document.createElement("input");
      input.type = field.type;
      input.id = field.id;
      input.required = true;

      container.appendChild(label);
      container.appendChild(input);
    });
  }

  // ---------------------------------------------------------
  // PAYMENT REDIRECT / RETURN (triggered from Step 2 only)
  // ---------------------------------------------------------

  function proceedToPayment(plan, price) {
    var email = val("organizerEmail");
    var name = val("organizerName");
    var phone = val("organizerPhone");

    // Matches payment.js's own stash shape/key exactly (plan, price,
    // organizerEmail, organizerName, organizerPhone, returnUrl).
    sessionStorage.setItem("ep_pending_plan", JSON.stringify({
      plan: plan,
      price: price,
      organizerEmail: email,
      organizerName: name,
      organizerPhone: phone,
      returnUrl: "apply-event.html"
    }));

    // Matches payment.js's readIncomingData() query param names.
    var qs = new URLSearchParams({
      plan: plan,
      price: price,
      email: email,
      name: name,
      phone: phone,
      returnUrl: "apply-event.html"
    });

    window.location.href = "payment.html?" + qs.toString();
  }

  function handlePaymentReturn() {
var params = new URLSearchParams(window.location.search);
var status = params.get("paymentStatus");

if (!status) return false;

  window.history.replaceState({}, document.title, window.location.pathname);

  // Read the stash BEFORE deleting it, and restore it into the form.
  var stashed = {};
  try { stashed = JSON.parse(sessionStorage.getItem("ep_pending_plan") || "{}"); } catch (e) {}

  if (stashed.organizerName)  document.getElementById("organizerName").value  = stashed.organizerName;
  if (stashed.organizerPhone) document.getElementById("organizerPhone").value = stashed.organizerPhone;
  if (stashed.organizerEmail) document.getElementById("organizerEmail").value = stashed.organizerEmail;
  if (stashed.plan) {
    state.plan = stashed.plan; // fallback used by collectFormData()
    var radio = document.querySelector('input[name="plan"][value="' + stashed.plan + '"]');
    if (radio) radio.checked = true;
    updatePlanContinueBtn();
  }
  state.otpVerified = true; // they already verified OTP before reaching Step 2
var stashed = {};
try {
    stashed = JSON.parse(sessionStorage.getItem("ep_pending_plan") || "{}");
} catch (e) {}

if (stashed.organizerName)
    document.getElementById("organizerName").value = stashed.organizerName;

if (stashed.organizerPhone)
    document.getElementById("organizerPhone").value = stashed.organizerPhone;

if (stashed.organizerEmail)
    document.getElementById("organizerEmail").value = stashed.organizerEmail;

if (stashed.plan) {
    state.plan = stashed.plan;

    var radio = document.querySelector(
        'input[name="plan"][value="' + stashed.plan + '"]'
    );

    if (radio)
        radio.checked = true;

    updatePlanContinueBtn();
}
    
  sessionStorage.removeItem("ep_pending_plan");
  sessionStorage.removeItem("eventpay_pending_application");

  if (status === "success") {
    state.eventStatus = "Active";
    goToStep(3);
  } else if (status === "pendingVerification") {
    state.eventStatus = "Inactive";
    goToStep(3);
  } else if (status === "failed") {
    goToStep(2);
    resetPlanSelection();
    showToast("Payment Failed. Please select a plan to try again.");
  }
    return true;
}

  function collectFormData() {
    var eventType = getSelectedEventType();
    var data = {
      organizerName: val("organizerName"),
      organizerPhone: val("organizerPhone"),
      organizerEmail: val("organizerEmail"),
      plan: getSelectedPlan() || state.plan,
      eventType: eventType,
      eventDate: val("eventDate"),
      eventTime: val("eventTime"),
      venue: val("venue"),
      mapsLink: val("mapsLink"),
      expectedGuests: val("expectedGuests"),
      upiId: val("upiId"),
      description: val("description"),

      eventStatus: state.eventStatus || "Active",
      confirmDuplicateOverride: state.duplicateAcknowledged
    };

    (DYNAMIC_FIELDS[eventType] || []).forEach(function (field) {
      data[field.id] = val(field.id);
    });

    data.autoEventName = buildAutoEventName(data);
    return data;
  }

  function buildAutoEventName(data) {
    switch (data.eventType) {
      case "Marriage": return "Wedding of " + (data.brideName || "") + " & " + (data.groomName || "");
      case "Reception": return "Reception of " + (data.brideName || "") + " & " + (data.groomName || "");
      case "Engagement": return "Engagement of " + (data.brideName || "") + " & " + (data.groomName || "");
      case "Birthday": return "Birthday of " + (data.birthdayPersonName || "");
      case "House Warming": return "House Warming of " + (data.familyName || "");
      case "Temple Festival": return (data.templeName || "") + " Temple Festival";
      case "Corporate Event": return (data.companyName || "") + " Corporate Event";
      case "Anniversary": return "Anniversary Celebration";
      case "Baby Shower": return "Baby Shower Celebration";
      default: return data.customEventName || "Event";
    }
  }

  // ---------------------------------------------------------
  // FINAL SUBMIT (STEP 4) — payment already resolved at Step 2
  // ---------------------------------------------------------

  function bindSubmit() {
    document.getElementById("applyForm").addEventListener("submit", function (e) {
      e.preventDefault();

      if (!document.getElementById("termsCheck").checked ||
          !document.getElementById("privacyCheck").checked) {
        showToast("Please accept both Terms & Conditions and Privacy Policy.");
        return;
      }

      var formData = collectFormData();
      submitForm(formData);
    });
  }

  function submitForm(formData) {

    setLoading(true, "Checking for duplicates…");

    runServer("checkDuplicateEvent", {
      organizerEmail: formData.organizerEmail,
      eventDate: formData.eventDate,
      eventName: formData.autoEventName
    })

    .then(function (dupRes) {

      if (dupRes.duplicate && !state.duplicateAcknowledged) {

        setLoading(false);

        var box = document.getElementById("duplicateWarning");
        box.textContent =
          dupRes.message + " Click Create Event again to proceed anyway.";

        box.classList.remove("hidden");
        state.duplicateAcknowledged = true;
        return;
      }

      setLoading(true, "Creating your event...\nEstimated time: less than 1 minute.");
      startLoadingCountdown();

      return runServer("submitEventApplication", formData);

    })

    .then(function (res) {

      if (!res) return; // duplicate-warning early return above

      setLoading(false);

      console.log("submitEventApplication response:", res);

      if (res.success) {
        stopLoadingCountdown();
        showResult(res);
        goToStep(5);

      } else {

        console.error("Submit Error:", res);
        alert(JSON.stringify(res, null, 2));
        stopLoadingCountdown();
        showToast(res.message || "Something went wrong.");

      }

    })

    .catch(function (err) {
      stopLoadingCountdown();
      setLoading(false);
      console.error(err);
      showToast("Error: " + err);

    });

  }

  // ---------------------------------------------------------
  // RESULT / SUCCESS SCREEN
  // ---------------------------------------------------------

  var lastResult = {};

  function showResult(res) {
    lastResult = res;
    var grid = document.getElementById("resultGrid");
    grid.innerHTML = "";

    var rows = [
      ["Event Name", res.eventName],
      ["Event Code", res.eventCode],
      ["Event ID", res.eventId],
      ["Spreadsheet Link", res.spreadsheetLink],
      ["Public URL", res.publicURL],
      ["Admin URL", res.adminURL],
      ["Admin Username", res.adminUsername],
      ["Temporary Password", res.adminPassword]
    ];

    rows.forEach(function (pair) {
      var row = document.createElement("div");
      row.className = "result-row";
      row.innerHTML = "<span class='label'>" + pair[0] + "</span><span class='value'>" + pair[1] + "</span>";
      grid.appendChild(row);
    });

    document.getElementById("openSheetBtn").href = res.spreadsheetLink;
    document.getElementById("openEventBtn").href = res.publicURL;
    document.getElementById("openAdminBtn").href = res.adminURL;
  }

  function bindResultButtons() {
    document.getElementById("copyCodeBtn").addEventListener("click", function () {
      copyToClipboard(lastResult.eventCode);
    });
    document.getElementById("copyPublicBtn").addEventListener("click", function () {
      copyToClipboard(lastResult.publicURL);
    });
    document.getElementById("copyAdminBtn").addEventListener("click", function () {
      copyToClipboard(lastResult.adminURL);
    });
  }

  function copyToClipboard(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      showToast("Copied to clipboard.");
    });
  }

  // ---------------------------------------------------------
  // UTILITIES
  // ---------------------------------------------------------

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : "";
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function getSelectedPlan() {
    var el = document.querySelector('input[name="plan"]:checked');
    return el ? el.value : null;
  }

  function getSelectedEventType() {
    var el = document.querySelector('input[name="eventType"]:checked');
    return el ? el.value : null;
  }

  function showToast(message) {
    var toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      toast.classList.add("hidden");
    }, 3500);
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

  /**
   * POSTs { action, ...params } as form-encoded data to your deployed
   * Web App, matching the doPost(e)/handleAction(action, p, pd, sid)
   * pattern already used by your MASTER Code.gs. No "sid" is sent —
   * these four actions all operate on MASTER_DB directly.
   *
   * Your backend's handleAction() must route these action names to
   * the wrapper functions in ApplyEvent.gs (see the router snippet at
   * the top of that file) — this is a fetch(), not google.script.run,
   * since this page is static (GitHub Pages), not HtmlService.
   */
  function runServer(actionName, params) {
    if (!APP_CONFIG.SCRIPT_URL) {
      return Promise.reject("SCRIPT_URL is not configured.");
    }

    var body = new URLSearchParams();
    body.set("action", actionName);
    Object.keys(params || {}).forEach(function (key) {
      body.set(key, params[key] === undefined || params[key] === null ? "" : String(params[key]));
    });

    return fetch(APP_CONFIG.SCRIPT_URL, {
      method: "POST",
      body: body
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Server responded with status " + response.status);
        }
        return response.json();
      })
      .then(function (json) {
        // Your router returns raw objects (e.g. {success:true,...} or
        // {error:"..."}) rather than a uniform envelope, so pass through
        // as-is but normalize the { error: "..." } shape to what this
        // page expects ({ success:false, message:"..." }).
        if (json && json.error && json.success === undefined) {
          return { success: false, message: json.error };
        }
        return json;
      });
  }

  // ---------------------------------------------------------
  // LOADING COUNTDOWN (used only during submitEventApplication)
  // ---------------------------------------------------------

  var loadingTimer = null;
  var loadingSeconds = 60;

  function startLoadingCountdown() {
    loadingSeconds = 60;

    var txt = document.getElementById("loadingText");

    if (loadingTimer) clearInterval(loadingTimer);

    txt.innerHTML =
      "Creating your event...<br>" +
      "This may take up to 1 minute.<br><br>" +
      "<b>Time Remaining: 60 sec</b>";

    loadingTimer = setInterval(function () {

      loadingSeconds--;

      txt.innerHTML =
        "Creating your event...<br>" +
        "This may take up to 1 minute.<br><br>" +
        "<b>Time Remaining: " + loadingSeconds + " sec</b>";

      if (loadingSeconds <= 0) {
        clearInterval(loadingTimer);
        txt.innerHTML = "Almost done...<br>Please wait a few more seconds.";
      }

    }, 1000);
  }

  function stopLoadingCountdown() {
    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
    }
  }

})();
