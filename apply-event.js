(function () {
  "use strict";

  var state = {
    currentStep: 1,
    totalSteps: 5,
    otpVerified: false,
    duplicateAcknowledged: false
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
    bindSubmit();
    bindResultButtons();
    handlePaymentReturn(); // resume flow after returning from payment.html
    goToStep(1);
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

    if (step === 2) {
      if (!getSelectedPlan()) {
        showToast("Please select a plan.");
        return false;
      }
      return true;
    }

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
  // SUBMIT / PAYMENT GATE
  // ---------------------------------------------------------
  //
  // Behavior:
  //  - Free plan (price <= 0): unchanged existing flow, submits directly.
  //  - Paid plan (Premium/Enterprise): redirect to payment.html instead of
  //    submitting. The existing "Create Event" button (submitBtn) is reused
  //    as-is; no new button is created. No submitEventApplication,
  //    checkDuplicateEvent, spreadsheet, or Drive folder calls happen until
  //    payment.html reports back with a paymentStatus.
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
      var price = PLAN_PRICES[formData.plan] || 0;

      if (price > 0) {
        proceedToPayment(formData, price);
      } else {
        submitForm(formData); // Free plan — unchanged existing flow
      }
    });
  }

  function proceedToPayment(formData, price) {
    // Full application data — payment.js never touches this key, so it
    // survives the round trip untouched.
    sessionStorage.setItem("eventpay_pending_application", JSON.stringify(formData));

    // Matches payment.js's own stash shape/key exactly (plan, price,
    // organizerEmail, organizerName, organizerPhone, returnUrl).
    sessionStorage.setItem("ep_pending_plan", JSON.stringify({
      plan: formData.plan,
      price: price,
      organizerEmail: formData.organizerEmail,
      organizerName: formData.organizerName,
      organizerPhone: formData.organizerPhone,
      returnUrl: "apply-event.html"
    }));

    // Matches payment.js's readIncomingData() query param names.
    var qs = new URLSearchParams({
      plan: formData.plan,
      price: price,
      email: formData.organizerEmail,
      name: formData.organizerName,
      phone: formData.organizerPhone,
      returnUrl: "apply-event.html"
    });

    window.location.href = "payment.html?" + qs.toString();
  }

  function handlePaymentReturn() {
    var params = new URLSearchParams(window.location.search);
    var status = params.get("paymentStatus");
    if (!status) return;

    // Clean the URL so a refresh doesn't re-trigger this.
    window.history.replaceState({}, document.title, window.location.pathname);

    var stored = sessionStorage.getItem("eventpay_pending_application");
    if (!stored) {
      if (status === "failed") showToast("Payment Failed.");
      return;
    }

    var formData = JSON.parse(stored);
    sessionStorage.removeItem("eventpay_pending_application");
    sessionStorage.removeItem("ep_pending_plan");

    if (status === "success") {
      formData.eventStatus = "Active";
      goToStep(4);
      submitForm(formData);
    } else if (status === "pendingVerification") {
      formData.eventStatus = "Inactive"; // Direct UPI, awaiting manual verification
      goToStep(4);
      submitForm(formData);
    } else if (status === "failed") {
      goToStep(4);
      showToast("Payment Failed. Your event was not created.");
    }
  }

  function collectFormData() {
    var eventType = getSelectedEventType();
    var data = {
      organizerName: val("organizerName"),
      organizerPhone: val("organizerPhone"),
      organizerEmail: val("organizerEmail"),
      plan: getSelectedPlan(),
      eventType: eventType,
      eventDate: val("eventDate"),
      eventTime: val("eventTime"),
      venue: val("venue"),
      mapsLink: val("mapsLink"),
      expectedGuests: val("expectedGuests"),
      upiId: val("upiId"),
      description: val("description"),

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
