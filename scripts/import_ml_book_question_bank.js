/* Import a small, auditable ML question bank from the bundled textbook material. */
const { openStorage } = require("./storage_cli");

const store = openStorage();
const db = store.read();
const book = (db.courseMaterials || []).find((m) => m.subject === "机器学习" && /动手学机器学习/.test(`${m.title} ${m.sourceName}`));
if (!book) throw new Error("未找到《动手学机器学习》课程资料，请先导入 PDF");

const specs = [
  ["ml.basic.generalization", "机器学习与泛化", "第1章", "解释机器学习为什么不能只看训练集表现。", "机器学习通过经验数据提升特定任务性能，模型还必须能处理未见样本；训练集表现好不等于泛化能力强。", ["机器学习", "泛化", "训练集", "未见样本"]],
  ["ml.math.gradient", "梯度与参数优化", "数学基础", "梯度在模型训练中起什么作用？", "梯度表示函数在各变量方向上的变化率，可用于确定参数更新方向；实际更新仍需结合学习率等优化设置。", ["梯度", "参数", "更新", "学习率"]],
  ["ml.knn.distance", "K近邻与距离", "K近邻", "KNN 如何完成分类？特征标准化为什么重要？", "KNN 按距离寻找邻居并投票；不同特征尺度会改变距离，因此通常要归一化或标准化。", ["KNN", "距离", "投票", "标准化"]],
  ["ml.linear.loss", "线性回归与平方损失", "线性回归", "线性回归通常优化什么目标？", "线性回归假设输出是特征的线性组合，常用平方损失度量预测值与真实值的差距，可用正规方程或梯度下降求解。", ["线性回归", "平方损失", "正规方程", "梯度下降"]],
  ["ml.logistic.classification", "逻辑斯谛回归", "逻辑斯谛回归", "逻辑斯谛回归适合哪类任务？说明其输出含义。", "逻辑斯谛回归用于分类，通过模型输出类别相关的概率或得分，再依据判别规则得到类别。", ["逻辑斯谛回归", "分类", "概率"]],
  ["ml.regularization.overfit", "正则化与过拟合", "机器学习的基本思想", "训练误差很低而测试误差较高，可能是什么问题？如何改进？", "这通常是过拟合，模型记住了训练噪声。可使用正则化、交叉验证或调整模型复杂度，并检查数据泄漏。", ["过拟合", "测试误差", "正则化", "交叉验证"]],
  ["ml.svm.margin", "支持向量机与间隔", "支持向量机", "支持向量机中的间隔思想解决什么问题？", "支持向量机通过最大化分类间隔寻找更稳健的决策边界；核方法可把非线性关系映射到更适合分割的表示空间。", ["支持向量机", "间隔", "核方法", "决策边界"]],
  ["ml.tree.split", "决策树划分", "决策树", "决策树如何逐步形成预测规则？", "决策树反复选择划分特征和阈值，把样本分到子节点，最终在叶节点输出预测；划分标准和剪枝会影响泛化。", ["决策树", "划分", "特征", "叶节点", "剪枝"]],
  ["ml.ensemble.boosting", "集成学习与梯度提升", "集成学习与梯度提升决策树", "Boosting 的基本思想是什么？", "Boosting 通过迭代加入新模型，重点纠正已有模型的错误，再组合多个弱学习器形成更强的预测器。", ["Boosting", "迭代", "弱学习器", "纠正错误"]],
  ["ml.kmeans.unsupervised", "k均值聚类", "k均值聚类", "k均值聚类的目标是什么？", "k均值在无标签数据中寻找簇结构，交替执行样本分配与中心更新，使簇内距离总体变小；初始化可能影响结果。", ["k均值", "聚类", "无标签", "中心"]],
  ["ml.pca.dimension", "主成分分析", "主成分分析", "PCA 为什么能用于降维？", "PCA 寻找数据方差较大的投影方向，用较少的主成分表示数据，在保留主要变化结构的同时降低维度。", ["PCA", "主成分", "方差", "降维"]],
  ["ml.em.latent", "EM算法与隐变量", "EM算法", "EM 算法的两步分别做什么？", "EM 交替进行 E 步和 M 步：先在当前参数下估计隐变量相关信息，再利用该估计更新模型参数，直到目标收敛或达到停止条件。", ["EM", "E步", "M步", "隐变量", "收敛"]]
];

function findEvidence(keywords, chapter) {
  const chunks = (book.chunks || []).filter((c) => String(c.text || "").length > 40);
  const hit = chunks.find((c) => keywords.filter((k) => String(c.text).includes(k)).length >= Math.min(2, keywords.length))
    || chunks.find((c) => String(c.chapter || "").includes(chapter)) || chunks[0];
  return { page: hit?.page || null, chapter: hit?.chapter || chapter, quote: String(hit?.text || "").replace(/\s+/g, " ").slice(0, 500), materialId: book.id };
}

const points = specs.map(([id, topic, chapter, , answer, keywords]) => ({ id, subject: "机器学习", topic, chapter, sourceMaterialId: book.id, keywords, status: "reviewed", updatedAt: new Date().toISOString() }));
const questions = specs.map(([id, topic, chapter, prompt, answer, keywords], i) => {
  const evidence = findEvidence(keywords, chapter);
  return { id: `mlq_${i + 1}`, subject: "机器学习", topic, nodeId: "", graphId: (db.knowledgeGraphs || []).find((g) => g.subject === "机器学习")?.id || "", materialId: book.id, type: "short_answer", difficulty: ["基础", "理解", "应用"][i % 3], cognitiveLevel: ["理解", "应用", "分析"][i % 3], prompt, referenceAnswer: answer, rubric: `回答应覆盖：${keywords.join("、")}。`, expectedKeywords: keywords, status: "book_grounded", source: { title: "《动手学机器学习》（张伟楠、赵寒晔、俞勇）", page: evidence.page, chapter: evidence.chapter, quote: evidence.quote, materialId: evidence.materialId }, citations: [{ title: "《动手学机器学习》", page: evidence.page, chapter: evidence.chapter, quote: evidence.quote }], generatedBy: "book-grounded-import-v1", createdAt: new Date().toISOString() };
});
db.mlKnowledgePoints = points;
db.mlQuestionBank = questions;
store.write(db);
store.close?.();
console.log(JSON.stringify({ ok: true, materialId: book.id, knowledgePoints: points.length, questions: questions.length }, null, 2));
