/* The AI assist's prompt configuration: what the model is asked to extract.
 * Shared by the page (app.js) and the extraction test (scripts/eval_assist.js),
 * so the test scores exactly the prompt visitors get. */
(function (g) {
  "use strict";
  var ASSIST_CONFIG = {
    title: "Fill from my plan.",
    lede: "Paste a training plan, a Slack message or a budget note. The model only fills the form; every value shows the phrase it came from, and you choose what to keep.",
    placeholder: "e.g. We need about 2,000 H100-hours over the next 6 weeks to finish the ablation runs. Checkpoints every 2 hours. Budget is around $9k. On-demand quotes are near $4 a GPU-hour; a 12-month reservation was quoted at $3.20.",
    examples: [
      { label: "A Slack message", text: "Quick plan check: the pretraining run needs roughly 12,000 A100-hours and it has to be done in 4 weeks for the workshop deadline. We checkpoint every hour. Finance gave us $30k for compute. Lambda quoted $1.90 on demand; reserved for a year was $1.50." },
      { label: "A budget note", text: "Compute request: 8 H100s for about 10 days straight, so call it 1,900 GPU-hours, ideally inside 2 weeks. No fixed budget yet. We save checkpoints every 30 minutes because the job is flaky." }
    ],
    instructions: "The tool plans how to buy GPU-hours for one training job (reserve, on demand, spot, or a mix) and how risky the bill is. Extract what the text states. GPU-hours: if the text gives a number of GPUs and a run time, multiply (8 GPUs for 300 hours is 2400 GPU-hours). Deadline is in weeks: convert days by dividing by 7 and months by multiplying by 4.345, rounding to the nearest whole week. The checkpoint interval is in hours (30 minutes is 0.5). Budget, on-demand price and reserved price are in US dollars per GPU-hour for the prices, total dollars for the budget ('$9k' is 9000). Only fill onDemand or reserved when the text prices that billing type; a spot price is not an on-demand price. termMonths is the reservation term in months when the text names one ('a year' is 12). gpu is one of H100, A100, V100, spelled exactly so; if the text names another GPU, leave gpu null and note it in questions.",
    fields: [
      { key: "gpu", label: "GPU type (H100, A100 or V100)", type: "text" },
      { key: "hours", label: "GPU-hours needed", type: "number" },
      { key: "weeks", label: "Deadline (weeks)", type: "number" },
      { key: "budget", label: "Budget ($, total)", type: "number" },
      { key: "ckptHours", label: "Checkpoint every (hours)", type: "number" },
      { key: "onDemand", label: "On-demand price ($ per GPU-hour)", type: "number" },
      { key: "reserved", label: "Reserved price ($ per GPU-hour)", type: "number" },
      { key: "termMonths", label: "Reservation term (months)", type: "number" }
    ]
  };
  if (typeof module !== "undefined" && module.exports) module.exports = ASSIST_CONFIG;
  g.ASSIST_CONFIG = ASSIST_CONFIG;
})(typeof window !== "undefined" ? window : globalThis);
