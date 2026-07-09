/* ============================================================
   apply-event.js
   ============================================================
   Talks to your Apps Script Web App via fetch(), matching the
   action=/sid= router pattern your MASTER Code.gs (v4.0) already
   uses — the same one index.html calls as EP.MASTER_URL.

   Set WEB_APP_URL below to your deployed Web App /exec URL (same
   one used in config.js as EP.MASTER_URL). This page is hosted on
   GitHub Pages, so google.script.run is never available here —
   only fetch() to the deployed Web App works.

   Backend side: ApplyEvent.gs must be included in the SAME Apps
   Script project as your MASTER Code.gs, and its four actions
   (sendOrganizerOtp, verifyOrganizerOtp, checkDuplicateEvent,
   submitEventApplication) must be added to handleAction() — see
   the router snippet at the top of ApplyEvent.gs.
   ============================================================ */

// Reuses the same Web App URL as index.html's EP.MASTER_URL (config.js),
// since Apply Event writes into the same MASTER_DB. If apply-event.html
// doesn't load config.js for some reason, falls back to this constant —
// replace with your deployed /exec URL either way if it's wrong.
var WEB_APP_URL = (typeof EP !== "undefined" && EP.MASTER_URL) ? EP.MASTER_URL : "REPLACE_WITH_YOUR_DEPLOYED_WEB_APP_EXEC_URL";

(function () {
  "use strict";

  var state = {
    currentStep: 1,
    totalSteps: 5,
    otpVerified: false,
    duplicateAcknowledged: false
  };

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
          showToast("Error sending OTP: " + err);
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
          showToast("Error verifying OTP: " + err);
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
  // SUBMIT
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
      if (!formData.spreadsheetLink) {
        showToast("Please paste your Google Spreadsheet link.");
        return;
      }
      if (!formData.eventDate || !formData.eventTime || !formData.venue) {
        showToast("Please fill in event date, time, and venue.");
        return;
      }

      submitForm(formData);
    });
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
      spreadsheetLink: val("spreadsheetLink"),
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
          box.textContent = dupRes.message + " Click Create Event again to proceed anyway.";
          box.classList.remove("hidden");
          state.duplicateAcknowledged = true;
          return;
        }

        setLoading(true, "Creating your event & spreadsheet…");
        return runServer("submitEventApplication", { formData: JSON.stringify(formData) }).then(function (res) {
          setLoading(false);
          if (res.success) {
            showResult(res);
            goToStep(5);
          } else {
            showToast(res.message || "Something went wrong.");
          }
        });
      })
      .catch(function (err) {
        setLoading(false);
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
    if (!WEB_APP_URL || WEB_APP_URL.indexOf("REPLACE_WITH") === 0) {
      return Promise.reject("WEB_APP_URL is not configured in apply-event.js.");
    }

    var body = new URLSearchParams();
    body.set("action", actionName);
    Object.keys(params || {}).forEach(function (key) {
      body.set(key, params[key] === undefined || params[key] === null ? "" : String(params[key]));
    });

    return fetch(WEB_APP_URL, {
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

})();
