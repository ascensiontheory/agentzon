// AGENTZON entry gate: humans get the storefront, agents get the machine door.
// Runs from <head> so a stored agent choice redirects before the page paints.
(function () {
  var KEY = "az_mode";
  var mode = null;
  try { mode = localStorage.getItem(KEY); } catch (e) {}
  // deep links can pick a door: agentzon.xyz/?mode=human or ?mode=agent
  var m = /[?&]mode=(human|agent)\b/.exec(location.search);
  if (m) { mode = m[1]; try { localStorage.setItem(KEY, mode); } catch (e) {} }
  if (mode === "agent") { location.replace("/agent"); return; }
  if (mode === "human") return; // returning human, no gate

  function set(m) { try { localStorage.setItem(KEY, m); } catch (e) {} }

  function show() {
    var gate = document.getElementById("gate");
    if (!gate) return;
    var human = document.getElementById("gateHuman");
    var agent = document.getElementById("gateAgent");
    gate.style.display = "flex";
    document.body.style.overflow = "hidden";

    function closeHuman() {
      set("human");
      gate.style.display = "none";
      document.body.style.overflow = "";
    }
    human.addEventListener("click", closeHuman);
    agent.addEventListener("click", function () {
      set("agent");
      location.href = "/agent";
    });
    // focus trap between the two choices; Escape counts as human
    document.addEventListener("keydown", function (e) {
      if (gate.style.display !== "flex") return;
      if (e.key === "Escape") closeHuman();
      if (e.key === "Tab") {
        e.preventDefault();
        (document.activeElement === human ? agent : human).focus();
      }
    });
    human.focus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show);
  else show();
})();
