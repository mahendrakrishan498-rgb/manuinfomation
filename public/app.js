(function () {
  var treatmentDays = [0, 3, 4, 6];
  var state = {
    currentUser: "",
    selectedDate: "",
    appointments: [],
    apiReady: false
  };

  var els = {};

  document.addEventListener("DOMContentLoaded", function () {
    bindElements();
    bindEvents();
    state.selectedDate = getDefaultTreatmentDate();
    initialize();
  });

  async function initialize() {
    try {
      var session = await api("/api/me");
      state.currentUser = session.user || "";
      if (state.currentUser) {
        await loadAppointments();
      }
      state.apiReady = true;
      render();
    } catch (error) {
      state.apiReady = false;
      render();
      showLoginError("");
    }
  }

  function bindElements() {
    els.loginView = document.getElementById("loginView");
    els.deskView = document.getElementById("deskView");
    els.loginPassword = document.getElementById("loginPassword");
    els.loginError = document.getElementById("loginError");
    els.userChip = document.getElementById("userChip");
    els.logoutButton = document.getElementById("logoutButton");
    els.quickDates = document.getElementById("quickDates");
    els.calendarDate = document.getElementById("calendarDate");
    els.dateHint = document.getElementById("dateHint");
    els.form = document.getElementById("appointmentForm");
    els.clearForm = document.getElementById("clearForm");
    els.patientName = document.getElementById("patientName");
    els.phoneNumber = document.getElementById("phoneNumber");
    els.appointmentTime = document.getElementById("appointmentTime");
    els.duration = document.getElementById("duration");
    els.note = document.getElementById("note");
    els.appointmentTitle = document.getElementById("appointmentTitle");
    els.appointmentCount = document.getElementById("appointmentCount");
    els.appointmentsList = document.getElementById("appointmentsList");
    els.template = document.getElementById("appointmentTemplate");
    els.exportButton = document.getElementById("exportButton");
    els.importFile = document.getElementById("importFile");
  }

  function bindEvents() {
    document.querySelectorAll("[data-login]").forEach(function (button) {
      button.addEventListener("click", async function () {
        var user = button.getAttribute("data-login");
        try {
          await api("/api/login", {
            method: "POST",
            body: { user: user, password: els.loginPassword.value }
          });
          state.currentUser = user;
          els.loginPassword.value = "";
          showLoginError("");
          await loadAppointments();
          render();
        } catch (error) {
          showLoginError(error.message || "Login failed.");
          els.loginPassword.focus();
        }
      });
    });

    els.logoutButton.addEventListener("click", async function () {
      try {
        await api("/api/logout", { method: "POST" });
      } catch (error) {
        // Logging out locally is still useful if the network drops.
      }
      state.currentUser = "";
      state.appointments = [];
      render();
    });

    els.calendarDate.addEventListener("change", function () {
      if (!els.calendarDate.value) return;
      state.selectedDate = els.calendarDate.value;
      render();
    });

    els.form.addEventListener("submit", function (event) {
      event.preventDefault();
      saveAppointment();
    });

    els.clearForm.addEventListener("click", resetForm);
    els.exportButton.addEventListener("click", exportData);
    els.importFile.addEventListener("change", importData);
  }

  function render() {
    var isLoggedIn = Boolean(state.currentUser);
    els.loginView.classList.toggle("hidden", isLoggedIn);
    els.deskView.classList.toggle("hidden", !isLoggedIn);

    if (!isLoggedIn) return;

    els.userChip.textContent = state.currentUser;
    els.userChip.className = "user-chip " + userClass(state.currentUser);
    els.calendarDate.min = todayIso();
    els.calendarDate.value = state.selectedDate;
    renderTreatmentDates();
    renderAppointments();
  }

  function renderTreatmentDates() {
    var dates = upcomingTreatmentDates(6);
    var selected = toDate(state.selectedDate);
    var selectedIsTreatment = treatmentDays.indexOf(selected.getDay()) !== -1;
    els.dateHint.textContent = selectedIsTreatment
      ? "Selected " + formatLongDate(state.selectedDate)
      : "Selected date is not a normal treatment day.";

    els.quickDates.innerHTML = "";
    dates.forEach(function (iso) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "date-button";
      if (iso === state.selectedDate) button.classList.add("active");
      button.innerHTML = "<strong>" + dayName(iso) + "</strong><span>" + formatShortDate(iso) + "</span>";
      button.addEventListener("click", function () {
        state.selectedDate = iso;
        render();
      });
      els.quickDates.appendChild(button);
    });
  }

  function renderAppointments() {
    var list = state.appointments
      .filter(function (item) { return item.date === state.selectedDate; })
      .sort(function (a, b) { return a.time.localeCompare(b.time); });

    els.appointmentTitle.textContent = "Appointments for " + formatLongDate(state.selectedDate);
    els.appointmentCount.textContent = list.length + (list.length === 1 ? " appointment" : " appointments");
    els.appointmentsList.innerHTML = "";

    if (!list.length) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No appointments for this date yet.";
      els.appointmentsList.appendChild(empty);
      return;
    }

    list.forEach(function (item) {
      var node = els.template.content.firstElementChild.cloneNode(true);
      var message = reminderMessage(item);
      node.classList.add(userClass(item.createdBy));
      node.querySelector(".item-time").textContent = item.time + " - " + endTime(item.time, item.duration);
      node.querySelector("h3").textContent = item.name;
      node.querySelector(".owner-badge").textContent = item.createdBy;
      node.querySelector(".phone-link").textContent = item.phone;
      node.querySelector(".phone-link").href = "tel:" + cleanPhone(item.phone);
      node.querySelector(".note-text").textContent = item.note || "No note";
      node.querySelector(".message-box textarea").value = message;
      node.querySelector(".sms-link").href = "sms:" + cleanPhone(item.phone) + "?&body=" + encodeURIComponent(message);
      node.querySelector(".whatsapp-link").href = "https://wa.me/" + whatsappNumber(item.phone) + "?text=" + encodeURIComponent(message);
      node.querySelector(".save-contact").href = contactFile(item);
      node.querySelector(".save-contact").download = item.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") + ".vcf";
      node.querySelector(".copy-message").addEventListener("click", function () {
        copyText(message);
      });
      node.querySelector(".delete-button").addEventListener("click", function () {
        deleteAppointment(item.id);
      });
      els.appointmentsList.appendChild(node);
    });
  }

  async function loadAppointments() {
    var payload = await api("/api/appointments");
    state.appointments = payload.appointments.map(normalizeAppointment);
  }

  async function saveAppointment() {
    var name = els.patientName.value.trim();
    var phone = els.phoneNumber.value.trim();
    var time = els.appointmentTime.value;
    if (!name || !phone || !time) return;

    try {
      var payload = await api("/api/appointments", {
        method: "POST",
        body: {
          date: state.selectedDate,
          time: time,
          duration: Number(els.duration.value || 60),
          name: name,
          phone: phone,
          note: els.note.value.trim()
        }
      });
      state.appointments.push(normalizeAppointment(payload.appointment));
      resetForm();
      renderAppointments();
    } catch (error) {
      window.alert(error.message || "Could not save appointment.");
    }
  }

  async function deleteAppointment(id) {
    var ok = window.confirm("Delete this appointment?");
    if (!ok) return;
    try {
      await api("/api/appointments/" + encodeURIComponent(id), { method: "DELETE" });
      state.appointments = state.appointments.filter(function (item) { return String(item.id) !== String(id); });
      renderAppointments();
    } catch (error) {
      window.alert(error.message || "Could not delete appointment.");
    }
  }

  function resetForm() {
    els.form.reset();
    els.appointmentTime.value = "09:00";
    els.duration.value = "60";
    els.patientName.focus();
  }

  function exportData() {
    var payload = {
      exportedAt: new Date().toISOString(),
      appointments: state.appointments
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "medhani-appointments-backup.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  function importData(event) {
    var file = event.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        var payload = JSON.parse(reader.result);
        var imported = Array.isArray(payload) ? payload : payload.appointments;
        if (!Array.isArray(imported)) throw new Error("Invalid backup");
        await api("/api/appointments/import", {
          method: "POST",
          body: { appointments: imported }
        });
        await loadAppointments();
        renderAppointments();
      } catch (error) {
        window.alert(error.message || "Could not import this file.");
      }
      els.importFile.value = "";
    };
    reader.readAsText(file);
  }

  async function api(path, options) {
    var request = options || {};
    var response = await fetch(path, {
      method: request.method || "GET",
      headers: request.body ? { "Content-Type": "application/json" } : undefined,
      credentials: "same-origin",
      body: request.body ? JSON.stringify(request.body) : undefined
    });
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(payload.error || "Server request failed (" + response.status + ").");
    }
    return payload;
  }

  function normalizeAppointment(item) {
    return {
      id: item.id,
      date: String(item.date).slice(0, 10),
      time: String(item.time).slice(0, 5),
      duration: Number(item.duration || item.durationMinutes || 60),
      name: item.name,
      phone: item.phone,
      note: item.note || "",
      createdBy: item.createdBy,
      createdAt: item.createdAt
    };
  }

  function upcomingTreatmentDates(count) {
    var dates = [];
    var cursor = toDate(todayIso());
    while (dates.length < count) {
      if (treatmentDays.indexOf(cursor.getDay()) !== -1) {
        dates.push(toIso(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }

  function getDefaultTreatmentDate() {
    return upcomingTreatmentDates(1)[0];
  }

  function todayIso() {
    return toIso(new Date());
  }

  function toIso(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, "0");
    var d = String(date.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  function toDate(iso) {
    var parts = iso.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function formatLongDate(iso) {
    return toDate(iso).toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  }

  function formatShortDate(iso) {
    return toDate(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric"
    });
  }

  function dayName(iso) {
    return toDate(iso).toLocaleDateString(undefined, { weekday: "long" });
  }

  function endTime(time, minutes) {
    var parts = time.split(":").map(Number);
    var date = new Date(2000, 0, 1, parts[0], parts[1]);
    date.setMinutes(date.getMinutes() + Number(minutes || 60));
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }

  function userClass(user) {
    return user === "Inputter 2" ? "inputter-2" : "inputter-1";
  }

  function cleanPhone(phone) {
    return phone.replace(/[^\d+]/g, "");
  }

  function whatsappNumber(phone) {
    var cleaned = cleanPhone(phone);
    if (cleaned.charAt(0) === "+") return cleaned.slice(1);
    if (cleaned.charAt(0) === "0") return "94" + cleaned.slice(1);
    return cleaned;
  }

  function reminderMessage(item) {
    var when = relativeDay(item.date);
    return "Hello " + item.name + ", your Medhani Ayurveda treatment appointment is " + when + " at " + item.time + ". Please arrive on time. Thank you.";
  }

  function contactFile(item) {
    var lines = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:" + item.name,
      "TEL:" + cleanPhone(item.phone),
      "NOTE:Medhani Ayurveda appointment patient",
      "END:VCARD"
    ];
    return "data:text/vcard;charset=utf-8," + encodeURIComponent(lines.join("\n"));
  }

  function relativeDay(iso) {
    var selected = toDate(iso);
    var today = toDate(todayIso());
    var diff = Math.round((selected - today) / 86400000);
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    return "on " + formatLongDate(iso);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      return;
    }
    var holder = document.createElement("textarea");
    holder.value = text;
    document.body.appendChild(holder);
    holder.select();
    document.execCommand("copy");
    document.body.removeChild(holder);
  }

  function showLoginError(message) {
    els.loginError.textContent = message;
  }
})();
