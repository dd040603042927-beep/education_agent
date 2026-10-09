const CHEATING_PATTERNS = [
  /代写|替我完成|直接给.*(?:作业|考试|试卷)|帮我(?:做|写).*(?:考试|试卷)/i,
  /绕过.*(?:权限|限制|检测)|伪造.*(?:成绩|提交|身份)/i,
  /作弊|答案泄露|获取.*(?:他人|老师).*答案/i
];

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  const aliases = { answer: "qa", rag: "qa", question: "qa", grading: "grade", correction: "grade", "lesson-plan": "plan" };
  return aliases[mode] || mode;
}

function inferIntent(prompt, requestedMode, role) {
  const text = String(prompt || "");
  const mode = normalizeMode(requestedMode);
  if (role === "teacher" || role === "admin") {
    if (/(批改|评分|rubric|作业反馈)/i.test(text) || mode === "grade") return "teacher_grading";
    if (/(出题|练习|测验|题目)/i.test(text) || mode === "practice") return "teacher_preparation";
    return "teacher_preparation";
  }
  if (/(错因|哪里错|诊断|批改|评分)/i.test(text) || mode === "grade") return "student_diagnosis";
  if (/(作业|提交|附件|图片|拍照)/i.test(text)) return "student_homework";
  return "student_qa";
}

function routeEducationalRequest({ prompt, requestedMode, role, hasStudentAnswer = false }) {
  const text = String(prompt || "").trim();
  if (!text) return { decision: "clarify", reason: "empty_prompt", message: "请描述要学习、批改或备课的具体内容。", confidence: 0 };
  const safety = CHEATING_PATTERNS.find((pattern) => pattern.test(text));
  if (safety) {
    return {
      decision: "blocked",
      reason: "academic_integrity",
      message: "该请求可能绕过学习或评价规则。可以提供讲解、提示、评分标准或让你展示自己的解题过程。",
      confidence: 1
    };
  }
  const intent = inferIntent(text, requestedMode, role);
  const ambiguous = text.length < 4 || (/^(这个|那个|不会|帮我看看)[。！？!?]?$/i.test(text));
  if (ambiguous) {
    return { decision: "clarify", reason: "low_confidence", message: "请补充学科、知识点，以及你希望得到讲解、诊断、批改还是备课支持。", confidence: 0.25 };
  }
  if (intent === "student_diagnosis" && !hasStudentAnswer) {
    return { decision: "clarify", reason: "missing_student_evidence", message: "错因诊断需要你的答案、思路或作答附件；先提交其中一项后才能给出诊断。", confidence: 0.88, intent };
  }
  return { decision: "allow", intent, confidence: hasStudentAnswer ? 0.92 : 0.78 };
}

module.exports = { routeEducationalRequest };
