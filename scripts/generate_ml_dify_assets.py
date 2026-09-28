from __future__ import annotations

import json
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "dify" / "ml_learning_diagnosis"
KB_DIR = OUT_DIR / "knowledge_base"


TOPICS = [
    {
        "name": "机器学习基础",
        "keywords": ["机器学习", "监督学习", "无监督学习", "强化学习", "泛化", "归纳偏置", "训练集", "测试集"],
        "summary": "机器学习研究如何让系统利用经验数据改进特定任务上的性能。学习时要同时说明任务、数据、模型、损失、优化和评价指标，而不是只记算法名称。",
        "inputs": "样本、特征、标签或反馈信号。",
        "objective": "从训练数据中学习可泛化的规律，在未见样本上保持稳定表现。",
        "metrics": "分类可用准确率、精确率、召回率、F1、AUC；回归可用 MSE、RMSE、MAE；聚类可用轮廓系数、SSE 等。",
        "practice": "先判断任务类型，再选择模型和评价指标；测试集只用于最终评估。",
        "pitfall": "不要把人工智能和机器学习完全等同，也不要把训练集表现好直接当成泛化能力强。",
    },
    {
        "name": "数学基础",
        "keywords": ["向量", "矩阵", "梯度", "凸函数", "范数", "内积", "协方差", "优化"],
        "summary": "向量和矩阵用于表达样本、参数和批量计算，梯度描述函数变化最快的方向，是训练模型时更新参数的核心工具。",
        "inputs": "数据矩阵、参数向量、目标函数和约束条件。",
        "objective": "用统一的数学语言描述模型预测、损失计算和参数更新。",
        "metrics": "重点检查维度是否匹配、目标函数是否可优化、梯度方向是否正确。",
        "practice": "写代码前先标注 X、y、w 的形状，避免张量维度错误。",
        "pitfall": "不要只背公式；很多推导错误来自矩阵维度不一致或把标量、向量、矩阵混用。",
    },
    {
        "name": "KNN",
        "keywords": ["KNN", "K近邻", "最近邻", "距离", "投票", "回归平均", "标准化", "K值"],
        "summary": "KNN 根据样本之间的距离寻找最近邻，分类时投票，回归时平均。它没有显式训练阶段，预测成本主要发生在查找邻居时。",
        "inputs": "带标签训练样本、距离度量、K 值和待预测样本。",
        "objective": "基于相似样本具有相似输出的假设完成预测。",
        "metrics": "分类看准确率、精确率、召回率、F1；回归看 MSE、RMSE、MAE。",
        "practice": "距离敏感模型通常需要归一化或标准化；K 太小易受噪声影响，K 太大可能忽略局部结构。",
        "pitfall": "不要把 KNN 的距离计算说成训练优化目标；它通常是基于实例的惰性学习方法。",
    },
    {
        "name": "线性回归",
        "keywords": ["线性回归", "平方损失", "均方误差", "MSE", "解析解", "正规方程", "梯度下降", "学习率"],
        "summary": "线性回归假设输出是特征的线性组合，常用平方损失度量预测值和真实值之间的差距。",
        "inputs": "特征矩阵、连续型目标值、参数向量和偏置项。",
        "objective": "最小化平方误差，可用正规方程求解析解，也可用梯度下降迭代优化。",
        "metrics": "MSE、RMSE、MAE、R2。",
        "practice": "比较解析解、手写梯度下降和 sklearn 实现，观察学习率对收敛的影响。",
        "pitfall": "线性通常指参数线性，不等于只能处理直线关系；特征变换后仍可表达非线性模式。",
    },
    {
        "name": "过拟合与泛化",
        "keywords": ["过拟合", "欠拟合", "泛化", "正则化", "L1", "L2", "验证集", "交叉验证", "数据泄漏"],
        "summary": "欠拟合表示模型能力不足或训练不足，训练和测试表现都差；过拟合表示模型记住训练噪声，训练表现好但测试表现差。",
        "inputs": "训练集、验证集、测试集、模型复杂度和正则化强度。",
        "objective": "在拟合训练数据和保持泛化能力之间取得平衡。",
        "metrics": "比较训练误差、验证误差、测试误差以及交叉验证均值和方差。",
        "practice": "用验证集调参，用测试集做最终一次评估；正则化、早停、数据增强和简化模型都可抑制过拟合。",
        "pitfall": "不要反复用测试集调参，也不要把验证集和测试集混用。",
    },
    {
        "name": "逻辑回归",
        "keywords": ["逻辑回归", "逻辑斯谛回归", "Sigmoid", "二分类", "交叉熵", "最大似然", "阈值", "概率"],
        "summary": "逻辑回归把线性得分通过 Sigmoid 或 Softmax 转成类别概率，名称中有回归，但常用于分类。",
        "inputs": "特征、类别标签、线性权重、偏置和分类阈值。",
        "objective": "最大化标签似然，等价地最小化交叉熵损失。",
        "metrics": "准确率、精确率、召回率、F1、AUC、混淆矩阵。",
        "practice": "类别不平衡时不要只看准确率；要结合阈值、召回率和精确率分析。",
        "pitfall": "不要因为名称里有回归就把逻辑回归当作连续值回归模型。",
    },
    {
        "name": "矩阵分解与推荐",
        "keywords": ["矩阵分解", "推荐系统", "隐因子", "用户向量", "物品向量", "评分预测", "冷启动", "稀疏"],
        "summary": "矩阵分解把用户-物品评分矩阵分解为低维用户向量和物品向量，用内积估计偏好。",
        "inputs": "用户、物品、评分或点击反馈，以及隐向量维度。",
        "objective": "最小化已观测评分预测误差，并用正则化控制过拟合。",
        "metrics": "RMSE、MAE、Top-K 命中率、NDCG、召回率。",
        "practice": "注意冷启动、稀疏性和训练/验证划分方式。",
        "pitfall": "隐向量不是人工指定的显式标签，而是模型从数据中学到的低维表示。",
    },
    {
        "name": "神经网络",
        "keywords": ["神经网络", "感知机", "多层感知机", "隐藏层", "激活函数", "反向传播", "ReLU", "Dropout"],
        "summary": "神经网络由层、权重、偏置和非线性激活组成，多层网络通过层次表示处理复杂模式。",
        "inputs": "张量输入、网络结构、损失函数、优化器和训练数据。",
        "objective": "通过反向传播计算梯度，用优化器迭代更新参数以降低损失。",
        "metrics": "任务相关指标以及训练损失、验证损失、收敛曲线。",
        "practice": "明确输入输出形状，设置合适学习率、批大小、正则化和随机种子。",
        "pitfall": "没有非线性激活的多层线性网络本质上仍可化为一个线性变换。",
    },
    {
        "name": "卷积神经网络",
        "keywords": ["CNN", "卷积", "卷积核", "特征图", "池化", "局部连接", "权值共享", "padding", "stride"],
        "summary": "CNN 通过局部连接和权值共享提取空间局部特征，适合图像等具有局部相关性的输入。",
        "inputs": "图像张量、卷积核、步幅、填充、池化和全连接层。",
        "objective": "学习能够提取边缘、纹理、形状等层次特征的参数。",
        "metrics": "分类准确率、Top-K 准确率、损失曲线和混淆矩阵。",
        "practice": "计算卷积输出尺寸时关注 padding、stride、kernel size。",
        "pitfall": "深度学习中的卷积核参数通常由训练得到，不是手工固定规则。",
    },
    {
        "name": "循环神经网络",
        "keywords": ["RNN", "GRU", "LSTM", "序列", "隐藏状态", "时间步", "门控", "梯度消失"],
        "summary": "RNN 通过隐藏状态在时间步之间传递历史信息，GRU 和 LSTM 用门控机制缓解长依赖问题。",
        "inputs": "序列输入、隐藏状态、时间步长度和门控参数。",
        "objective": "建模当前输出与当前输入及历史上下文之间的关系。",
        "metrics": "序列分类、序列标注、预测误差或语言模型困惑度。",
        "practice": "处理变长序列时要关注 padding、mask、批处理和隐藏状态初始化。",
        "pitfall": "RNN 不只看当前输入，它的输出依赖当前输入和历史隐藏状态。",
    },
    {
        "name": "支持向量机",
        "keywords": ["SVM", "支持向量机", "支持向量", "最大间隔", "软间隔", "核函数", "C", "gamma", "RBF"],
        "summary": "SVM 寻找最大间隔分类超平面，支持向量是决定边界的关键样本，核函数用于处理非线性可分问题。",
        "inputs": "特征、标签、核函数、惩罚参数 C 和核参数 gamma。",
        "objective": "在间隔最大化和分类错误惩罚之间平衡。",
        "metrics": "准确率、精确率、召回率、F1、AUC。",
        "practice": "SVM 对特征尺度敏感，通常需要标准化；C 和 gamma 会显著影响过拟合风险。",
        "pitfall": "核技巧不是显式把所有样本坐标搬到高维空间，而是通过核函数计算相似度。",
    },
    {
        "name": "决策树",
        "keywords": ["决策树", "ID3", "C4.5", "CART", "信息增益", "增益率", "基尼指数", "剪枝"],
        "summary": "决策树递归划分特征空间，形成一系列可解释的判断规则。",
        "inputs": "样本特征、标签、划分准则、最大深度和叶子节点限制。",
        "objective": "选择能显著降低不纯度或误差的特征划分。",
        "metrics": "分类准确率、F1、回归误差、树深度和泛化差距。",
        "practice": "限制最大深度、最小叶子样本数或剪枝可降低过拟合。",
        "pitfall": "可解释性强不等于一定泛化好；不加约束的树很容易记住训练数据。",
    },
    {
        "name": "集成学习",
        "keywords": ["集成学习", "Bagging", "随机森林", "Boosting", "AdaBoost", "GBDT", "残差", "负梯度"],
        "summary": "集成学习组合多个基学习器提升稳定性或精度。Bagging 主要降方差，Boosting 逐步纠错以降偏差。",
        "inputs": "多个基学习器、采样策略、迭代轮数、学习率和树复杂度。",
        "objective": "通过模型组合得到比单模型更稳健的预测。",
        "metrics": "分类或回归指标，以及训练误差和验证误差差距。",
        "practice": "随机森林强调样本和特征随机性；GBDT 逐轮拟合损失的负梯度或残差。",
        "pitfall": "集成不是简单堆模型，基学习器差异性和组合方式决定效果。",
    },
    {
        "name": "KMeans聚类",
        "keywords": ["KMeans", "K均值", "聚类", "簇", "簇中心", "SSE", "肘部法", "轮廓系数", "KMeans++"],
        "summary": "KMeans 在无标签数据中寻找簇结构，交替执行样本分配和簇中心更新。",
        "inputs": "无标签样本、簇数 K、距离度量和初始化中心。",
        "objective": "最小化样本到所属簇中心的平方距离和 SSE。",
        "metrics": "SSE、轮廓系数、可视化结果和业务解释。",
        "practice": "标准化特征、尝试不同 K、使用 KMeans++ 减少初始化不稳定。",
        "pitfall": "聚类编号不是天然真实标签；KMeans 是无监督学习，不是分类算法。",
    },
    {
        "name": "PCA降维",
        "keywords": ["PCA", "主成分", "降维", "方差最大化", "协方差矩阵", "特征值", "特征向量", "解释方差率"],
        "summary": "PCA 寻找保留数据最大方差的正交方向，用低维主成分表示原始数据。",
        "inputs": "数值特征矩阵、目标维度或解释方差率阈值。",
        "objective": "在降低维度的同时尽量保留数据主要变化信息。",
        "metrics": "解释方差率、重构误差、下游任务效果和可视化效果。",
        "practice": "先中心化或标准化，再做 PCA；高方差方向不一定最有利于分类。",
        "pitfall": "PCA 是无监督方法，不直接利用类别标签。",
    },
    {
        "name": "朴素贝叶斯",
        "keywords": ["朴素贝叶斯", "贝叶斯", "先验", "似然", "后验", "条件独立", "拉普拉斯平滑", "文本分类"],
        "summary": "朴素贝叶斯基于贝叶斯公式和条件独立假设，常用于文本分类等高维稀疏场景。",
        "inputs": "类别先验、词频特征、条件概率和平滑参数。",
        "objective": "选择后验概率最大的类别。",
        "metrics": "准确率、精确率、召回率、F1。",
        "practice": "文本分类中常用多项式朴素贝叶斯和拉普拉斯平滑处理未见词。",
        "pitfall": "条件独立是假设，不代表真实特征完全独立；它用于简化计算。",
    },
    {
        "name": "EM与GMM",
        "keywords": ["EM", "GMM", "高斯混合", "隐变量", "E步", "M步", "似然", "软聚类"],
        "summary": "EM 适合含隐变量的概率模型参数估计，GMM 用多个高斯成分表示复杂分布。",
        "inputs": "观测数据、隐变量、初始参数、混合权重、均值和协方差。",
        "objective": "E 步估计隐变量后验，M 步更新参数，使似然通常不下降。",
        "metrics": "对数似然、BIC、AIC、聚类效果和可视化。",
        "practice": "不同初始化可能得到不同局部最优，需要多次运行或合理初始化。",
        "pitfall": "EM 不是一次求全局最优，而是在隐变量估计和参数更新之间迭代改进。",
    },
    {
        "name": "自编码器",
        "keywords": ["自编码器", "编码器", "解码器", "隐表示", "重构误差", "降维", "去噪", "异常检测"],
        "summary": "自编码器由编码器和解码器组成，通过重构输入学习低维或鲁棒表示。",
        "inputs": "输入样本、瓶颈层维度、编码器、解码器和重构损失。",
        "objective": "最小化重构误差，使隐表示保留关键信息。",
        "metrics": "重构误差、下游任务效果、异常检测召回率和可视化。",
        "practice": "可加入瓶颈层、稀疏约束、噪声或正则化，避免只学复制函数。",
        "pitfall": "无标签训练不等于不需要目标；自编码器的训练目标是重构输入。",
    },
]


MISCONCEPTIONS = [
    {
        "title": "KNN vs KMeans",
        "wrong": "把 KNN 和 KMeans 都说成分类算法，或只因为名字里都有 K 就认为它们流程相同。",
        "correct": "KNN 是监督学习方法，用已标注近邻投票或平均进行预测；KMeans 是无监督聚类方法，通过迭代更新簇中心划分无标签样本。",
        "diagnosis": ["概念混淆", "任务类型错误", "算法流程缺失"],
        "rubric": "能说出监督/无监督、标签是否存在、K 的含义、预测或聚类流程，可给高分。",
    },
    {
        "title": "分类 vs 聚类",
        "wrong": "把所有把样本分成几组的任务都叫分类。",
        "correct": "分类依赖训练标签学习类别边界，聚类在没有标签时根据相似性发现结构。",
        "diagnosis": ["任务类型错误", "适用场景不清"],
        "rubric": "答案应明确是否有标签、输出含义和评价方式。",
    },
    {
        "title": "回归 vs 分类",
        "wrong": "看到“逻辑回归”就认为它一定输出连续值，或把线性回归用于类别概率解释。",
        "correct": "回归通常预测连续值；逻辑回归输出类别概率并用于分类。",
        "diagnosis": ["概念混淆", "评价指标误用"],
        "rubric": "应区分输出空间、损失函数和常用评价指标。",
    },
    {
        "title": "训练集、验证集、测试集",
        "wrong": "用测试集反复调参，或把验证集结果当成最终泛化性能。",
        "correct": "训练集用于学习参数，验证集用于模型选择和调参，测试集只用于最终评估。",
        "diagnosis": ["泛化意识不足", "数据泄漏"],
        "rubric": "能说明三者用途及测试集隔离原则，说明为什么避免泄漏。",
    },
    {
        "title": "过拟合 vs 欠拟合",
        "wrong": "只看训练准确率判断模型好坏，或把训练好测试差也称为欠拟合。",
        "correct": "欠拟合是训练和测试都差；过拟合是训练好但测试差。",
        "diagnosis": ["泛化意识不足"],
        "rubric": "应结合训练误差和验证/测试误差共同判断。",
    },
    {
        "title": "准确率、精确率、召回率、F1",
        "wrong": "类别极不平衡时只看准确率，忽略少数类表现。",
        "correct": "精确率关注预测为正的样本有多少是真的，召回率关注真实正类有多少被找回，F1 平衡两者。",
        "diagnosis": ["评价指标误用"],
        "rubric": "应能结合混淆矩阵解释指标适用场景。",
    },
    {
        "title": "标准化和数据泄漏",
        "wrong": "先对全量数据做标准化，再划分训练集和测试集。",
        "correct": "标准化参数应只在训练集上拟合，再应用到验证集和测试集。",
        "diagnosis": ["数据预处理缺失", "数据泄漏"],
        "rubric": "距离模型、SVM、PCA 等场景应主动提到尺度处理。",
    },
    {
        "title": "KMeans 目标函数",
        "wrong": "只说 KMeans 把数据分组，没有说明迭代目标。",
        "correct": "KMeans 交替分配样本到最近中心并更新中心，目标是最小化簇内平方距离和。",
        "diagnosis": ["公式目标缺失", "算法流程缺失"],
        "rubric": "应包含初始化、分配、更新、收敛和 SSE。",
    },
    {
        "title": "PCA 与分类",
        "wrong": "认为 PCA 一定能让类别最容易分开。",
        "correct": "PCA 保留最大方差方向，是无监督降维，不直接优化分类边界。",
        "diagnosis": ["任务类型错误", "适用场景不清"],
        "rubric": "应说明方差最大化、主成分、解释方差率和无监督属性。",
    },
    {
        "title": "朴素贝叶斯条件独立",
        "wrong": "把条件独立假设当成真实数据一定满足的结论。",
        "correct": "条件独立是假设，用来简化后验概率计算；真实特征可能相关，但模型仍可有效。",
        "diagnosis": ["公式目标缺失", "概念混淆"],
        "rubric": "应能说出先验、似然、后验和平滑。",
    },
    {
        "title": "SVM 核函数",
        "wrong": "认为核函数必须显式计算高维特征坐标。",
        "correct": "核技巧通过核函数计算内积效果，避免显式构造高维映射。",
        "diagnosis": ["概念混淆", "参数影响不清"],
        "rubric": "应提到最大间隔、支持向量、C、gamma 和标准化。",
    },
    {
        "title": "决策树、随机森林、GBDT",
        "wrong": "把三者都说成一棵树，忽略集成方式。",
        "correct": "决策树是单模型；随机森林用 Bagging 和特征随机性降低方差；GBDT 逐轮拟合残差或负梯度。",
        "diagnosis": ["概念混淆", "算法流程缺失"],
        "rubric": "应能区分单树、Bagging、Boosting 的训练目标和风险。",
    },
]


def topic_keypoints_md() -> str:
    lines = [
        "# ml_keypoints.md",
        "",
        "来源说明：本文件根据《动手学机器学习》课程结构和本地测试讲义进行教学化整理，用于 Dify RAG 知识库导入。内容为知识点摘要、诊断提示和实践提醒，不逐字复制教材正文。",
        "",
        "导入建议：分段长度 400-600 tokens，重叠 50-100 tokens，top_k=5，score_threshold=0.30-0.45。若环境支持 rerank，建议开启。",
        "",
        "## 课程总览",
        "",
        "机器学习学习诊断应围绕六个维度展开：任务类型、输入输出、模型假设、目标函数或机制、评价指标、失败原因。学生只背模型名称但不能说明这些维度时，通常属于浅层掌握。",
        "",
    ]
    for idx, topic in enumerate(TOPICS, 1):
        lines.extend(
            [
                f"## {idx}. {topic['name']}",
                "",
                f"关键词：{'、'.join(topic['keywords'])}",
                "",
                f"核心理解：{topic['summary']}",
                "",
                f"输入输出：{topic['inputs']}",
                "",
                f"目标或机制：{topic['objective']}",
                "",
                f"评价指标：{topic['metrics']}",
                "",
                f"代码与实验提示：{topic['practice']}",
                "",
                f"易错提醒：{topic['pitfall']}",
                "",
            ]
        )
    lines.extend(
        [
            "## 诊断使用方式",
            "",
            "当学生回答较短时，优先判断其是否说清任务类型和输入输出；当学生回答较完整时，再检查目标函数、算法流程、评价指标、适用场景和预处理。对考试复习型问题，应输出可得分的结构化要点；对代码实践型问题，应强调数据形状、训练流程、超参数和可复现实验。",
            "",
        ]
    )
    return "\n".join(lines)


def quiz_bank_md() -> str:
    lines = [
        "# ml_quiz_bank.md",
        "",
        "用途：作为 Dify 学习诊断工作流的题库、标准答案和评分点知识库。每题均可用于 RAG 检索、追问生成和掌握度评分参考。",
        "",
    ]
    for idx, topic in enumerate(TOPICS, 1):
        lines.extend(
            [
                f"## Q{idx}. {topic['name']} 典型题",
                "",
                f"题目：请解释 {topic['name']} 的核心思想、输入输出、关键目标或机制，并说明一个常见错误。",
                "",
                "标准答案：",
                f"{topic['summary']}输入输出方面，{topic['inputs']}关键目标或机制是：{topic['objective']}评价时可关注：{topic['metrics']}实践中要注意：{topic['practice']}",
                "",
                "评分点：",
                "- 能正确判断任务类型或方法定位，2 分。",
                "- 能说明输入输出和关键变量，2 分。",
                "- 能说明目标函数、优化机制或预测流程，3 分。",
                "- 能说明评价指标和适用场景，2 分。",
                "- 能指出一个常见误区或实验注意事项，1 分。",
                "",
                f"常见错误：{topic['pitfall']}",
                "",
            ]
        )
    lines.extend(
        [
            "## 综合题 1：KNN 和 KMeans 有什么区别？",
            "",
            "标准答案：KNN 是监督学习，依赖已标注样本，预测时寻找最近邻并投票或平均；KMeans 是无监督聚类，输入无标签样本，交替分配样本到最近簇中心并更新中心，目标是最小化簇内平方距离和。两者都对特征尺度敏感，但 K 的含义不同：KNN 的 K 是邻居数量，KMeans 的 K 是簇数。",
            "",
            "评分点：监督/无监督 2 分；标签与输出含义 2 分；算法流程 3 分；K 的含义 1 分；标准化和适用场景 2 分。",
            "",
            "## 综合题 2：如何判断过拟合并改进？",
            "",
            "标准答案：若训练集表现明显优于验证集或测试集，通常说明模型过拟合。可通过降低模型复杂度、增加正则化、早停、交叉验证、数据增强、更多数据或改进特征处理缓解。调参应使用验证集，测试集只用于最终评估。",
            "",
            "评分点：训练/验证表现对比 3 分；改进方法 4 分；验证集和测试集边界 3 分。",
            "",
            "## 综合题 3：为什么类别不平衡时不能只看准确率？",
            "",
            "标准答案：当负类远多于正类时，模型即使几乎都预测为负也可能有很高准确率，但少数类召回很差。应结合混淆矩阵、精确率、召回率、F1、AUC 等指标，并根据业务成本选择阈值。",
            "",
            "评分点：指出准确率陷阱 3 分；解释精确率和召回率 3 分；给出 F1/AUC/阈值或混淆矩阵 4 分。",
            "",
        ]
    )
    return "\n".join(lines)


def misconceptions_md() -> str:
    lines = [
        "# ml_misconceptions.md",
        "",
        "用途：作为 Dify 的错因知识库，用于检索常见误区、易混淆点和评分标准。建议单独建成“机器学习错因与评分标准”知识库，并绑定到工作流的错因知识库检索_RAG 节点。",
        "",
        "## 错因标签说明",
        "",
        "- 概念混淆：把相近算法、任务或指标混为一谈。",
        "- 任务类型错误：监督/无监督、分类/回归/聚类/降维判断错误。",
        "- 公式目标缺失：没有说明目标函数、损失函数、概率目标或优化方向。",
        "- 算法流程缺失：没有说明初始化、训练、预测、更新或迭代步骤。",
        "- 参数影响不清：不能解释 K、学习率、正则化强度、C、gamma、树深度等超参数。",
        "- 评价指标误用：指标与任务不匹配，或类别不平衡时只看准确率。",
        "- 泛化意识不足：忽略过拟合、欠拟合、交叉验证和测试集隔离。",
        "- 数据预处理缺失：忽略标准化、归一化、缺失值、类别不平衡或数据泄漏。",
        "- 代码实践薄弱：不能把数学符号对应到数组形状、训练循环和库函数参数。",
        "- 适用场景不清：不能说明模型优缺点、限制和使用条件。",
        "",
    ]
    for idx, item in enumerate(MISCONCEPTIONS, 1):
        lines.extend(
            [
                f"## M{idx}. {item['title']}",
                "",
                f"错误表现：{item['wrong']}",
                "",
                f"正确理解：{item['correct']}",
                "",
                f"建议错因标签：{'、'.join(item['diagnosis'])}",
                "",
                f"评分标准：{item['rubric']}",
                "",
                "追问建议：请学生用“任务类型、是否有标签、目标函数或预测流程、评价指标”四个角度重新解释。",
                "",
            ]
        )
    lines.extend(
        [
            "## 通用评分规则",
            "",
            "90-100：能完整说明任务类型、输入输出、目标函数或核心流程、评价指标、适用场景和常见陷阱，并能举例。",
            "",
            "75-89：主概念正确，能说明主要流程和至少一个评价指标，但对超参数、局限或公式细节不够完整。",
            "",
            "60-74：知道算法用途，但解释偏概括，缺少目标函数、流程细节、评价指标或适用条件。",
            "",
            "40-59：只背出少量关键词，存在明显概念混淆或任务类型错误。",
            "",
            "0-39：回答与问题关联很弱，或把核心任务、标签条件、目标函数完全说反。",
            "",
        ]
    )
    return "\n".join(lines)


INPUT_CLEANING_CODE = r'''
import json
import re

TOPIC_KEYWORDS = {
    "机器学习基础": ["机器学习", "监督学习", "无监督学习", "强化学习", "泛化", "归纳偏置", "训练集", "测试集"],
    "KNN": ["KNN", "K近邻", "最近邻", "距离", "投票", "K值", "标准化"],
    "线性回归": ["线性回归", "平方损失", "均方误差", "MSE", "梯度下降", "学习率"],
    "逻辑回归": ["逻辑回归", "Sigmoid", "交叉熵", "二分类", "精确率", "召回率", "F1"],
    "SVM": ["SVM", "支持向量机", "支持向量", "最大间隔", "核函数", "C", "gamma"],
    "决策树": ["决策树", "信息增益", "基尼", "剪枝", "CART", "ID3", "C4.5"],
    "集成学习": ["集成学习", "随机森林", "Bagging", "Boosting", "GBDT", "AdaBoost"],
    "KMeans聚类": ["KMeans", "K均值", "聚类", "簇中心", "SSE", "轮廓系数"],
    "PCA降维": ["PCA", "主成分", "降维", "协方差", "特征值", "解释方差率"],
    "朴素贝叶斯": ["朴素贝叶斯", "贝叶斯", "先验", "似然", "后验", "条件独立"],
    "神经网络": ["神经网络", "感知机", "反向传播", "激活函数", "ReLU", "Dropout"],
    "EM与GMM": ["EM", "GMM", "高斯混合", "隐变量", "E步", "M步"],
    "自编码器": ["自编码器", "编码器", "解码器", "重构误差", "隐表示"],
}

def _text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)

def _clean(value, limit):
    value = re.sub(r"\s+", " ", _text(value)).strip()
    return value[:limit]

def _norm_option(value, allowed, default):
    value = _clean(value, 40)
    return value if value in allowed else default

def _extract_keywords(text):
    lower = text.lower()
    hits = []
    for topic, kws in TOPIC_KEYWORDS.items():
        score = 0
        for kw in kws:
            if kw.lower() in lower:
                score += 1
                hits.append(kw)
        if score:
            hits.append(topic)
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9_+#.-]{1,30}", text)
    hits.extend(tokens[:8])
    unique = []
    seen = set()
    for item in hits:
        key = item.lower()
        if key and key not in seen:
            seen.add(key)
            unique.append(item)
    return unique[:16]

def main(question: str, student_answer: str = "", target_level: str = "考试复习", diagnosis_depth: str = "标准", student_id: str = "", class_id: str = "") -> dict:
    question_clean = _clean(question, 1200)
    student_answer_clean = _clean(student_answer, 2500)
    target_level_norm = _norm_option(target_level, ["入门理解", "考试复习", "代码实践", "原理推导"], "考试复习")
    diagnosis_depth_norm = _norm_option(diagnosis_depth, ["简洁", "标准", "深度"], "标准")
    student_id_clean = _clean(student_id, 80)
    class_id_clean = _clean(class_id, 80)

    has_answer = bool(student_answer_clean)
    diagnosis_mode = "学习诊断模式" if has_answer else "知识问答模式"
    keywords = _extract_keywords(question_clean + " " + student_answer_clean)
    keyword_text = " ".join(keywords)

    rag_query = f"{question_clean} {keyword_text} 学习目标:{target_level_norm}".strip()
    if has_answer:
        rag_query = f"{rag_query} 学生理解摘要:{student_answer_clean[:220]}"
    misconception_query = f"常见误区 易混淆 评分标准 错因标签 {question_clean} {keyword_text} {student_answer_clean[:260]}".strip()

    return {
        "question_clean": question_clean,
        "student_answer_clean": student_answer_clean,
        "target_level_norm": target_level_norm,
        "diagnosis_depth_norm": diagnosis_depth_norm,
        "diagnosis_mode": diagnosis_mode,
        "has_student_answer": "true" if has_answer else "false",
        "candidate_keywords": json.dumps(keywords, ensure_ascii=False),
        "rag_query": rag_query[:1500],
        "misconception_query": misconception_query[:1500],
        "student_id_clean": student_id_clean,
        "class_id_clean": class_id_clean,
    }
'''


EVIDENCE_CODE = r'''
import json
import re

def _as_text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)

def _load(value):
    if isinstance(value, (list, dict)):
        return value
    text = _as_text(value).strip()
    if not text:
        return []
    try:
        return json.loads(text)
    except Exception:
        return text

def _docs(value, source_type):
    value = _load(value)
    docs = []
    if isinstance(value, dict):
        for key in ["result", "documents", "records", "data"]:
            if isinstance(value.get(key), list):
                value = value[key]
                break
        else:
            value = [value]
    if isinstance(value, list):
        for i, item in enumerate(value):
            if isinstance(item, dict):
                metadata = item.get("metadata") or {}
                segment = item.get("segment") or {}
                content = (
                    item.get("content")
                    or item.get("text")
                    or item.get("page_content")
                    or segment.get("content")
                    or metadata.get("content")
                    or _as_text(item)
                )
                title = item.get("title") or metadata.get("document_name") or metadata.get("source") or segment.get("document", {}).get("name") or source_type
                score = item.get("score") or item.get("similarity") or item.get("rerank_score") or 0
            else:
                content = _as_text(item)
                title = source_type
                score = 0
            docs.append({"content": _as_text(content), "title": _as_text(title), "score": float(score or 0), "source_type": source_type, "idx": i + 1})
    else:
        parts = [p.strip() for p in re.split(r"\n\s*\n", _as_text(value)) if p.strip()]
        for i, part in enumerate(parts[:8]):
            docs.append({"content": part, "title": source_type, "score": 0, "source_type": source_type, "idx": i + 1})
    return docs

def _key(text):
    text = re.sub(r"\s+", "", text.lower())
    return text[:120]

def main(course_context="", misconception_context="") -> dict:
    all_docs = _docs(course_context, "课程知识库") + _docs(misconception_context, "错因知识库")
    seen = set()
    deduped = []
    for doc in all_docs:
        content = re.sub(r"\s+", " ", doc["content"]).strip()
        if not content:
            continue
        key = _key(content)
        if key in seen:
            continue
        seen.add(key)
        doc["content"] = content[:650]
        deduped.append(doc)
    deduped.sort(key=lambda x: (x["score"], len(x["content"])), reverse=True)
    selected = deduped[:5]
    citations = []
    lines = []
    for i, doc in enumerate(selected, 1):
        item = {
            "id": f"E{i}",
            "source": doc["source_type"],
            "title": doc["title"],
            "score": round(doc["score"], 4),
            "content": doc["content"],
        }
        citations.append(item)
        lines.append(f"[E{i}] {doc['source_type']}｜{doc['title']}｜{doc['content']}")
    evidence_summary = "\n".join(lines) if lines else "未检索到足够证据。请检查 Dify 知识库是否已绑定 ml_keypoints.md、ml_quiz_bank.md 和 ml_misconceptions.md。"
    return {
        "evidence_summary": evidence_summary,
        "citation_items": json.dumps(citations, ensure_ascii=False),
        "evidence_count": len(citations),
    }
'''


NB_CODE = r'''
import json
import math
import re

TOPIC_KEYWORDS = {
    "机器学习基础": ["机器学习", "监督学习", "无监督学习", "强化学习", "泛化", "归纳偏置", "训练集", "测试集"],
    "数学基础": ["向量", "矩阵", "梯度", "凸函数", "范数", "内积", "协方差", "优化"],
    "KNN": ["KNN", "K近邻", "最近邻", "距离", "投票", "回归平均", "标准化", "K值"],
    "线性回归": ["线性回归", "平方损失", "均方误差", "MSE", "正规方程", "梯度下降", "学习率"],
    "过拟合与泛化": ["过拟合", "欠拟合", "泛化", "正则化", "L1", "L2", "验证集", "交叉验证", "数据泄漏"],
    "逻辑回归": ["逻辑回归", "逻辑斯谛", "Sigmoid", "二分类", "交叉熵", "最大似然", "精确率", "召回率", "F1"],
    "矩阵分解与推荐": ["矩阵分解", "推荐", "隐因子", "用户向量", "物品向量", "评分预测", "冷启动"],
    "神经网络": ["神经网络", "感知机", "多层感知机", "隐藏层", "激活函数", "反向传播", "ReLU", "Dropout"],
    "卷积神经网络": ["CNN", "卷积", "卷积核", "特征图", "池化", "padding", "stride", "权值共享"],
    "循环神经网络": ["RNN", "GRU", "LSTM", "序列", "隐藏状态", "时间步", "门控", "梯度消失"],
    "支持向量机": ["SVM", "支持向量机", "支持向量", "最大间隔", "软间隔", "核函数", "C", "gamma"],
    "决策树": ["决策树", "ID3", "C4.5", "CART", "信息增益", "增益率", "基尼", "剪枝"],
    "集成学习": ["集成学习", "Bagging", "随机森林", "Boosting", "AdaBoost", "GBDT", "残差", "负梯度"],
    "KMeans聚类": ["KMeans", "K均值", "聚类", "簇", "簇中心", "SSE", "肘部法", "轮廓系数", "KMeans++"],
    "PCA降维": ["PCA", "主成分", "降维", "方差", "协方差", "特征值", "特征向量", "解释方差率"],
    "朴素贝叶斯": ["朴素贝叶斯", "贝叶斯", "先验", "似然", "后验", "条件独立", "拉普拉斯平滑", "文本分类"],
    "EM与GMM": ["EM", "GMM", "高斯混合", "隐变量", "E步", "M步", "似然", "软聚类"],
    "自编码器": ["自编码器", "编码器", "解码器", "隐表示", "重构误差", "异常检测"],
}

VOCAB = sorted({kw.lower() for kws in TOPIC_KEYWORDS.values() for kw in kws})

def _text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)

def _feature_counts(text):
    lower = _text(text).lower()
    counts = {}
    for token in VOCAB:
        c = lower.count(token)
        if c:
            counts[token] = c
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_+#.-]{1,30}", lower):
        if token in VOCAB:
            counts[token] = counts.get(token, 0) + 1
    return counts

def _softmax(log_scores):
    top = max(log_scores.values())
    exp_scores = {k: math.exp(v - top) for k, v in log_scores.items()}
    total = sum(exp_scores.values()) or 1.0
    return {k: v / total for k, v in exp_scores.items()}

def main(question_clean: str, student_answer_clean: str = "", evidence_summary: str = "", diagnosis_mode: str = "知识问答模式") -> dict:
    text = f"{question_clean}\n{student_answer_clean}\n{_text(evidence_summary)[:1500]}"
    observed = _feature_counts(text)
    class_count = len(TOPIC_KEYWORDS)
    alpha = 0.35
    log_scores = {}
    for topic, kws in TOPIC_KEYWORDS.items():
        class_tokens = [kw.lower() for kw in kws]
        total = len(class_tokens) + alpha * len(VOCAB)
        logp = math.log(1.0 / class_count)
        for token, count in observed.items():
            token_count = class_tokens.count(token)
            logp += count * math.log((token_count + alpha) / total)
        if topic.lower() in text.lower():
            logp += 1.25
        log_scores[topic] = logp
    probs = _softmax(log_scores)
    ranked = sorted(probs.items(), key=lambda x: x[1], reverse=True)
    if not observed:
        ranked = [("机器学习基础", 0.35)] + [(t, p) for t, p in ranked if t != "机器学习基础"][:2]
    topic_label = ranked[0][0]
    probability = round(float(ranked[0][1]), 4)
    top3 = [{"topic": t, "probability": round(float(p), 4)} for t, p in ranked[:3]]
    return {
        "topic_label": topic_label,
        "topic_probability": probability,
        "top_topic_candidates": json.dumps(top3, ensure_ascii=False),
        "diagnosis_mode": diagnosis_mode,
    }
'''


MASTERY_CODE = r'''
import json
import re

TOPIC_KEYWORDS = {
    "KNN": ["KNN", "K近邻", "距离", "最近邻", "投票", "平均", "标准化", "K值"],
    "线性回归": ["线性回归", "平方损失", "均方误差", "MSE", "梯度下降", "学习率", "解析解"],
    "逻辑回归": ["逻辑回归", "Sigmoid", "二分类", "交叉熵", "概率", "阈值", "精确率", "召回率"],
    "支持向量机": ["SVM", "支持向量", "最大间隔", "软间隔", "核函数", "C", "gamma"],
    "决策树": ["决策树", "信息增益", "基尼", "剪枝", "CART", "树深度"],
    "集成学习": ["随机森林", "Bagging", "Boosting", "GBDT", "残差", "负梯度"],
    "KMeans聚类": ["KMeans", "K均值", "聚类", "簇中心", "SSE", "迭代", "轮廓系数"],
    "PCA降维": ["PCA", "主成分", "降维", "方差", "协方差", "特征值", "解释方差率"],
    "朴素贝叶斯": ["朴素贝叶斯", "先验", "似然", "后验", "条件独立", "平滑"],
}

FORMULA_TERMS = ["目标", "损失", "函数", "最小化", "最大化", "MSE", "SSE", "交叉熵", "似然", "间隔", "方差", "概率"]
PROCESS_TERMS = ["步骤", "流程", "初始化", "训练", "预测", "更新", "迭代", "分配", "反向传播", "梯度下降"]
SCENARIO_TERMS = ["适合", "场景", "优点", "缺点", "局限", "用于", "当", "如果"]
METRIC_TERMS = ["准确率", "精确率", "召回率", "F1", "AUC", "MSE", "RMSE", "MAE", "轮廓系数", "SSE"]
PREPROCESS_TERMS = ["标准化", "归一化", "缺失值", "类别不平衡", "数据泄漏", "尺度", "量纲"]

def _text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)

def _has_any(text, terms):
    return any(term.lower() in text.lower() for term in terms)

def _coverage(answer, topic):
    kws = TOPIC_KEYWORDS.get(topic, [])
    if not kws:
        kws = []
    matched = [kw for kw in kws if kw.lower() in answer.lower()]
    return matched, (len(matched) / max(len(kws), 1))

def _level(score):
    if score <= 0:
        return "未诊断"
    if score < 45:
        return "薄弱"
    if score < 65:
        return "基本理解"
    if score < 85:
        return "较好掌握"
    return "熟练掌握"

def main(question_clean: str, student_answer_clean: str = "", topic_label: str = "机器学习基础", evidence_summary: str = "", target_level_norm: str = "考试复习", diagnosis_mode: str = "知识问答模式") -> dict:
    answer = _text(student_answer_clean).strip()
    question = _text(question_clean)
    topic = _text(topic_label) or "机器学习基础"
    if not answer:
        missing = ["未提供学生自我理解，当前仅生成标准解释。"]
        return {
            "mastery_score": 0,
            "mastery_level": "未诊断",
            "error_tags": json.dumps([], ensure_ascii=False),
            "missing_points": json.dumps(missing, ensure_ascii=False),
            "positive_points": json.dumps([], ensure_ascii=False),
            "project_sync_suggestion": "未提供 student_answer，建议不写入错题本，仅保存问答记录。",
        }

    matched, coverage = _coverage(answer, topic)
    score = 28
    score += min(len(answer) / 10, 22)
    score += coverage * 26

    dimensions = {
        "公式/目标函数": _has_any(answer, FORMULA_TERMS),
        "算法流程": _has_any(answer, PROCESS_TERMS),
        "适用场景": _has_any(answer, SCENARIO_TERMS),
        "评价指标": _has_any(answer, METRIC_TERMS),
    }
    if topic in ["KNN", "KMeans聚类", "PCA降维", "支持向量机"]:
        dimensions["数据预处理"] = _has_any(answer, PREPROCESS_TERMS)
    score += sum(6 for ok in dimensions.values() if ok)

    errors = []
    combined = f"{question}\n{answer}"
    if topic == "KMeans聚类" and "分类" in answer and "无监督" not in answer:
        errors.append("概念混淆")
        errors.append("任务类型错误")
    if topic == "KNN" and "聚类" in answer and "监督" not in answer:
        errors.append("概念混淆")
    if topic == "逻辑回归" and "连续" in answer and "分类" not in answer:
        errors.append("任务类型错误")
    if topic == "PCA降维" and "标签" in answer and "无监督" not in answer:
        errors.append("任务类型错误")
    if topic != "KNN" and not dimensions["公式/目标函数"]:
        errors.append("公式目标缺失")
    if not dimensions["算法流程"] and target_level_norm in ["考试复习", "代码实践", "原理推导"]:
        errors.append("算法流程缺失")
    if not dimensions["评价指标"] and target_level_norm in ["考试复习", "代码实践"]:
        errors.append("评价指标误用")
    if "测试集" in combined and "调参" in combined:
        errors.append("数据泄漏")
    if topic in ["KNN", "KMeans聚类", "PCA降维", "支持向量机"] and not dimensions.get("数据预处理", True):
        errors.append("数据预处理缺失")

    unique_errors = []
    for item in errors:
        if item not in unique_errors:
            unique_errors.append(item)
    score -= len(unique_errors) * 6
    score = int(max(0, min(100, round(score))))

    missing = []
    for name, ok in dimensions.items():
        if not ok:
            missing.append(f"缺少{name}说明")
    if coverage < 0.35:
        missing.append("关键词覆盖不足")
    if not missing:
        missing.append("可继续补充公式推导或代码实现细节")

    positives = []
    if matched:
        positives.append("已覆盖关键词：" + "、".join(matched[:8]))
    for name, ok in dimensions.items():
        if ok:
            positives.append(f"已提到{name}")

    sync_suggestion = "建议写入 conversations，并根据错因标签生成 wrongNotes。"
    if score >= 85:
        sync_suggestion = "建议更新 learningProfiles 为较高掌握度，可不加入错题本。"
    elif unique_errors:
        sync_suggestion = "建议写入 wrongNotes，并在学习画像中降低对应知识点掌握度。"

    return {
        "mastery_score": score,
        "mastery_level": _level(score),
        "error_tags": json.dumps(unique_errors, ensure_ascii=False),
        "missing_points": json.dumps(missing, ensure_ascii=False),
        "positive_points": json.dumps(positives, ensure_ascii=False),
        "project_sync_suggestion": sync_suggestion,
    }
'''


JSON_OUTPUT_CODE = r'''
import json

def _text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)

def _json_or_list(value):
    text = _text(value).strip()
    if not text:
        return []
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else [data]
    except Exception:
        return [x.strip() for x in text.replace("、", ",").split(",") if x.strip()]

def _next_questions(topic, missing_points):
    topic = topic or "该知识点"
    questions = [
        f"请用一句话说明{topic}的任务类型和输入输出。",
        f"{topic}的核心目标函数或预测流程是什么？",
    ]
    if any("评价指标" in _text(x) for x in missing_points):
        questions.append(f"评价{topic}时应选择哪些指标，为什么？")
    else:
        questions.append(f"{topic}在什么场景下不适合使用？")
    return questions[:3]

def main(
    question_clean: str,
    student_answer_clean: str = "",
    diagnosis_mode: str = "知识问答模式",
    topic_label: str = "",
    topic_probability: float = 0,
    top_topic_candidates: str = "[]",
    mastery_score: float = 0,
    mastery_level: str = "未诊断",
    error_tags: str = "[]",
    missing_points: str = "[]",
    citation_items: str = "[]",
    standard_answer: str = "",
    diagnosis_feedback: str = "",
    project_sync_suggestion: str = "",
    student_id_clean: str = "",
    class_id_clean: str = "",
) -> dict:
    errors = _json_or_list(error_tags)
    missing = _json_or_list(missing_points)
    evidence = _json_or_list(citation_items)
    candidates = _json_or_list(top_topic_candidates)
    standard = _text(standard_answer).strip()
    feedback = _text(diagnosis_feedback).strip()
    if not feedback and diagnosis_mode == "知识问答模式":
        feedback = "未提供学生自我理解，当前为知识问答模式，暂不进行掌握度扣分诊断。"
    elif not feedback:
        feedback = "诊断反馈节点未返回内容，请检查 LLM 节点配置。"

    next_questions = _next_questions(topic_label, missing)
    result = {
        "topic_label": topic_label,
        "topic_probability": topic_probability,
        "top_topic_candidates": candidates,
        "mastery_score": int(float(mastery_score or 0)),
        "mastery_level": mastery_level,
        "error_tags": errors,
        "missing_points": missing,
        "rag_evidence": evidence,
        "standard_answer": standard,
        "diagnosis_feedback": feedback,
        "next_questions": next_questions,
        "project_sync_suggestion": project_sync_suggestion,
    }

    final_answer = "\n\n".join([
        f"## 知识点定位\n{topic_label}（置信度 {topic_probability}）",
        f"## 掌握度\n{mastery_level}，得分 {int(float(mastery_score or 0))}",
        "## 标准解释\n" + standard,
        "## 诊断反馈\n" + feedback,
        "## 追问题\n" + "\n".join([f"{i+1}. {q}" for i, q in enumerate(next_questions)]),
    ])

    callback_payload = {
        "student_id": student_id_clean,
        "class_id": class_id_clean,
        "question": question_clean,
        "student_answer": student_answer_clean,
        "topic_label": topic_label,
        "mastery_score": int(float(mastery_score or 0)),
        "mastery_level": mastery_level,
        "error_tags": errors,
        "missing_points": missing,
        "final_answer": final_answer,
        "structured_result": result,
    }

    return {
        "final_answer": final_answer,
        "structured_json": json.dumps(result, ensure_ascii=False),
        "callback_payload": json.dumps(callback_payload, ensure_ascii=False),
        "rag_evidence": json.dumps(evidence, ensure_ascii=False),
    }
'''


def code_outputs(*names: str) -> dict:
    result = {}
    for name in names:
        result[name] = {"children": None, "type": "number" if name in {"mastery_score", "topic_probability", "evidence_count"} else "string"}
    return result


def node(node_id: str, title: str, node_type: str, x: int, y: int, data: dict, height: int = 92) -> dict:
    merged = {"desc": data.pop("desc", ""), "selected": False, "title": title, "type": node_type}
    merged.update(data)
    return {
        "data": merged,
        "height": height,
        "id": node_id,
        "position": {"x": x, "y": y},
        "positionAbsolute": {"x": x, "y": y},
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": 244,
    }


def edge(source: str, target: str, source_type: str, target_type: str, source_handle: str = "source") -> dict:
    return {
        "data": {"isInIteration": False, "sourceType": source_type, "targetType": target_type},
        "id": f"{source}-{source_handle}-{target}",
        "source": source,
        "sourceHandle": source_handle,
        "target": target,
        "targetHandle": "target",
        "type": "custom",
        "zIndex": 0,
    }


def llm_node_data(desc: str, system_text: str, user_text: str, context_selector=None) -> dict:
    data = {
        "context": {"enabled": bool(context_selector), "variable_selector": context_selector or []},
        "desc": desc,
        "model": {"completion_params": {"temperature": 0.25}, "mode": "chat", "name": "gpt-4o-mini", "provider": "openai"},
        "prompt_template": [
            {"id": "system-prompt", "role": "system", "text": system_text},
            {"id": "user-prompt", "role": "user", "text": "【用户原始查询】\n{{#start.question#}}\n\n[Dify checklist marker] sys.query\n\n" + user_text},
        ],
        "variables": [],
        "vision": {"enabled": False},
    }
    return data


def workflow_yaml() -> dict:
    start_vars = [
        {"label": "机器学习问题", "max_length": 1200, "options": [], "required": True, "type": "paragraph", "variable": "question"},
    ]

    nodes = [
        node("start", "开始", "start", 80, 280, {"desc": "请输入要解答的机器学习问题。", "variables": start_vars}, 248),
        node(
            "input_cleaning",
            "输入清洗与任务识别_代码节点",
            "code",
            390,
            280,
            {
                "desc": "清洗空格、截断超长文本，判断问答模式或诊断模式，抽取候选关键词并生成两个 RAG 查询词。",
                "code": INPUT_CLEANING_CODE.strip(),
                "code_language": "python3",
                "outputs": code_outputs("question_clean", "student_answer_clean", "target_level_norm", "diagnosis_depth_norm", "diagnosis_mode", "has_student_answer", "candidate_keywords", "rag_query", "misconception_query", "student_id_clean", "class_id_clean"),
                "variables": [
                    {"value_selector": ["start", "question"], "variable": "question"},
                ],
            },
            92,
        ),
        node(
            "course_rag",
            "课程知识库检索_RAG",
            "knowledge-retrieval",
            700,
            205,
            {
                "desc": "导入后在此节点绑定课程知识库，建议包含 ml_keypoints.md 和 ml_quiz_bank.md。dataset_ids 需在 Dify 中手动选择。",
                "dataset_ids": [],
                "multiple_retrieval_config": {"reranking_enable": False, "reranking_mode": "reranking_model", "reranking_model": {"model": "", "provider": ""}, "score_threshold": 0.35, "top_k": 5},
                "query_variable_selector": ["input_cleaning", "rag_query"],
                "retrieval_mode": "multiple",
            },
            92,
        ),
        node(
            "mistake_rag",
            "错因知识库检索_RAG",
            "knowledge-retrieval",
            700,
            380,
            {
                "desc": "导入后在此节点绑定错因知识库，建议包含 ml_misconceptions.md，也可加入评分细则和历年错题。",
                "dataset_ids": [],
                "multiple_retrieval_config": {"reranking_enable": False, "reranking_mode": "reranking_model", "reranking_model": {"model": "", "provider": ""}, "score_threshold": 0.30, "top_k": 5},
                "query_variable_selector": ["input_cleaning", "misconception_query"],
                "retrieval_mode": "multiple",
            },
            92,
        ),
        node(
            "evidence_merge",
            "RAG片段去重与证据整理_代码节点",
            "code",
            1010,
            280,
            {
                "desc": "合并课程知识库和错因知识库结果，去重后保留前 3-5 条证据，输出 evidence_summary 和 citation_items。",
                "code": EVIDENCE_CODE.strip(),
                "code_language": "python3",
                "outputs": code_outputs("evidence_summary", "citation_items", "evidence_count"),
                "variables": [
                    {"value_selector": ["course_rag", "result"], "variable": "course_context"},
                    {"value_selector": ["mistake_rag", "result"], "variable": "misconception_context"},
                ],
            },
            92,
        ),
        node(
            "nb_classifier",
            "朴素贝叶斯知识点分类_代码节点",
            "code",
            1320,
            280,
            {
                "desc": "使用多项式朴素贝叶斯 + 关键词特征，对问题、学生回答和 RAG 证据进行知识点分类，输出概率和 Top3 候选。",
                "code": NB_CODE.strip(),
                "code_language": "python3",
                "outputs": code_outputs("topic_label", "topic_probability", "top_topic_candidates", "diagnosis_mode"),
                "variables": [
                    {"value_selector": ["input_cleaning", "question_clean"], "variable": "question_clean"},
                    {"value_selector": ["input_cleaning", "student_answer_clean"], "variable": "student_answer_clean"},
                    {"value_selector": ["evidence_merge", "evidence_summary"], "variable": "evidence_summary"},
                    {"value_selector": ["input_cleaning", "diagnosis_mode"], "variable": "diagnosis_mode"},
                ],
            },
            92,
        ),
        node(
            "mastery_scoring",
            "掌握度评分_代码节点",
            "code",
            1630,
            280,
            {
                "desc": "根据回答长度、关键词覆盖、RAG 证据匹配、公式/流程/场景/指标和错因扣分输出掌握度。",
                "code": MASTERY_CODE.strip(),
                "code_language": "python3",
                "outputs": code_outputs("mastery_score", "mastery_level", "error_tags", "missing_points", "positive_points", "project_sync_suggestion"),
                "variables": [
                    {"value_selector": ["input_cleaning", "question_clean"], "variable": "question_clean"},
                    {"value_selector": ["input_cleaning", "student_answer_clean"], "variable": "student_answer_clean"},
                    {"value_selector": ["nb_classifier", "topic_label"], "variable": "topic_label"},
                    {"value_selector": ["evidence_merge", "evidence_summary"], "variable": "evidence_summary"},
                    {"value_selector": ["input_cleaning", "target_level_norm"], "variable": "target_level_norm"},
                    {"value_selector": ["input_cleaning", "diagnosis_mode"], "variable": "diagnosis_mode"},
                ],
            },
            92,
        ),
        node(
            "llm_standard",
            "LLM标准解释节点",
            "llm",
            1940,
            280,
            llm_node_data(
                "专门生成基于 RAG 的标准答案，不混入学生评价。",
                "你是高校机器学习课程助教。请只生成标准解释或参考答案，不评价学生掌握度。必须优先依据 RAG 证据；证据不足时说明“知识库依据不足，以下为课程通用解释”。回答要适配学习目标和诊断深度。",
                "【清洗后的问题】\n{{#input_cleaning.question_clean#}}\n\n【学习目标】{{#input_cleaning.target_level_norm#}}\n【诊断深度】{{#input_cleaning.diagnosis_depth_norm#}}\n【知识点分类】{{#nb_classifier.topic_label#}}，置信度 {{#nb_classifier.topic_probability#}}\n\n【RAG证据】\n{{#evidence_merge.evidence_summary#}}\n\n请输出：\n1. 核心结论\n2. 原理或流程\n3. 公式/目标函数或关键机制\n4. 评价指标与适用场景\n5. 一句易错提醒",
                ["evidence_merge", "evidence_summary"],
            ),
            92,
        ),
        node(
            "mode_branch",
            "条件分支_问答或诊断",
            "if-else",
            2250,
            280,
            {
                "desc": "没有 student_answer 时走知识问答模式；有 student_answer 时走学习诊断模式。",
                "cases": [
                    {
                        "case_id": "true",
                        "conditions": [
                            {"comparison_operator": "empty", "id": "cond_no_student_answer", "value": "", "varType": "string", "variable_selector": ["input_cleaning", "student_answer_clean"]}
                        ],
                        "logical_operator": "and",
                    }
                ],
            },
            92,
        ),
        node(
            "llm_diagnosis",
            "LLM诊断反馈节点",
            "llm",
            2560,
            390,
            llm_node_data(
                "专门生成已掌握部分、错因分析、个性化建议、追问题和参考答案摘要。",
                "你是机器学习学习诊断助手。你要基于学生回答、RAG证据和算法评分输出诊断反馈。不要重新虚构证据，不要给与得分矛盾的评价。输出要具体指出已掌握、错因、补救建议和追问。",
                "【清洗后的问题】\n{{#input_cleaning.question_clean#}}\n\n【学生自我理解】\n{{#input_cleaning.student_answer_clean#}}\n\n【标准解释】\n{{#llm_standard.text#}}\n\n【算法诊断】\n知识点：{{#nb_classifier.topic_label#}}\n掌握度：{{#mastery_scoring.mastery_level#}}，得分 {{#mastery_scoring.mastery_score#}}\n错因标签：{{#mastery_scoring.error_tags#}}\n缺失点：{{#mastery_scoring.missing_points#}}\n\n【RAG证据】\n{{#evidence_merge.evidence_summary#}}\n\n请输出：\n1. 已掌握部分\n2. 错因分析\n3. 个性化学习建议\n4. 追问题\n5. 参考答案摘要",
                ["evidence_merge", "evidence_summary"],
            ),
            92,
        ),
        node(
            "json_output",
            "输出结构化JSON_代码节点",
            "code",
            2870,
            280,
            {
                "desc": "把标准答案、诊断反馈、算法结果和 RAG 证据整理成统一 JSON，同时生成项目回调 payload。",
                "code": JSON_OUTPUT_CODE.strip(),
                "code_language": "python3",
                "outputs": code_outputs("final_answer", "structured_json", "callback_payload", "rag_evidence"),
                "variables": [
                    {"value_selector": ["input_cleaning", "question_clean"], "variable": "question_clean"},
                    {"value_selector": ["input_cleaning", "student_answer_clean"], "variable": "student_answer_clean"},
                    {"value_selector": ["input_cleaning", "diagnosis_mode"], "variable": "diagnosis_mode"},
                    {"value_selector": ["nb_classifier", "topic_label"], "variable": "topic_label"},
                    {"value_selector": ["nb_classifier", "topic_probability"], "variable": "topic_probability"},
                    {"value_selector": ["nb_classifier", "top_topic_candidates"], "variable": "top_topic_candidates"},
                    {"value_selector": ["mastery_scoring", "mastery_score"], "variable": "mastery_score"},
                    {"value_selector": ["mastery_scoring", "mastery_level"], "variable": "mastery_level"},
                    {"value_selector": ["mastery_scoring", "error_tags"], "variable": "error_tags"},
                    {"value_selector": ["mastery_scoring", "missing_points"], "variable": "missing_points"},
                    {"value_selector": ["evidence_merge", "citation_items"], "variable": "citation_items"},
                    {"value_selector": ["llm_standard", "text"], "variable": "standard_answer"},
                    {"value_selector": ["llm_diagnosis", "text"], "variable": "diagnosis_feedback"},
                    {"value_selector": ["mastery_scoring", "project_sync_suggestion"], "variable": "project_sync_suggestion"},
                    {"value_selector": ["input_cleaning", "student_id_clean"], "variable": "student_id_clean"},
                    {"value_selector": ["input_cleaning", "class_id_clean"], "variable": "class_id_clean"},
                ],
            },
            92,
        ),
        node(
            "http_callback",
            "项目数据库同步_HTTP节点",
            "http-request",
            3180,
            280,
            {
                "desc": "可选加分节点：把诊断结果回写项目接口。使用前请把 URL 和 Bearer Token 改成项目后端配置；若暂未实现回调，可在 Dify 中断开此节点。",
                "authorization": {"config": {"api_key": "change-me", "type": "bearer"}, "type": "api-key"},
                "body": {"data": [{"key": "", "type": "text", "value": "{{#json_output.callback_payload#}}"}], "type": "json"},
                "headers": "Content-Type: application/json",
                "method": "post",
                "params": "",
                "timeout": {"connect": 5, "max_connect_timeout": 0, "max_read_timeout": 0, "max_write_timeout": 0, "read": 30, "write": 30},
                "url": "http://127.0.0.1:5107/api/integrations/dify/diagnosis-callback",
            },
            92,
        ),
        node(
            "end",
            "结束",
            "end",
            3490,
            280,
            {
                "desc": "输出最终学习诊断结果。",
                "outputs": [
                    {"value_selector": ["json_output", "final_answer"], "variable": "final_answer"},
                    {"value_selector": ["nb_classifier", "topic_label"], "variable": "topic_label"},
                    {"value_selector": ["input_cleaning", "diagnosis_mode"], "variable": "diagnosis_mode"},
                    {"value_selector": ["mastery_scoring", "mastery_level"], "variable": "mastery_level"},
                    {"value_selector": ["mastery_scoring", "mastery_score"], "variable": "mastery_score"},
                    {"value_selector": ["mastery_scoring", "error_tags"], "variable": "error_tags"},
                    {"value_selector": ["json_output", "rag_evidence"], "variable": "rag_evidence"},
                    {"value_selector": ["http_callback", "status_code"], "variable": "sync_status"},
                ],
            },
            92,
        ),
    ]

    edges = [
        edge("start", "input_cleaning", "start", "code"),
        edge("input_cleaning", "course_rag", "code", "knowledge-retrieval"),
        edge("input_cleaning", "mistake_rag", "code", "knowledge-retrieval"),
        edge("course_rag", "evidence_merge", "knowledge-retrieval", "code"),
        edge("mistake_rag", "evidence_merge", "knowledge-retrieval", "code"),
        edge("evidence_merge", "nb_classifier", "code", "code"),
        edge("nb_classifier", "mastery_scoring", "code", "code"),
        edge("mastery_scoring", "llm_standard", "code", "llm"),
        edge("llm_standard", "mode_branch", "llm", "if-else"),
        edge("mode_branch", "json_output", "if-else", "code", "true"),
        edge("mode_branch", "llm_diagnosis", "if-else", "llm", "false"),
        edge("llm_diagnosis", "json_output", "llm", "code"),
        edge("json_output", "http_callback", "code", "http-request"),
        edge("http_callback", "end", "http-request", "end"),
    ]

    return {
        "app": {
            "description": "基于《动手学机器学习》知识库的多 RAG 机器学习问答与学习诊断工作流。包含输入清洗、课程知识库检索、错因知识库检索、证据整理、朴素贝叶斯知识点分类、掌握度评分、条件分支、标准解释、诊断反馈、结构化 JSON 输出和项目回调。",
            "icon": "🤖",
            "icon_background": "#E0F2FE",
            "mode": "workflow",
            "name": "机器学习知识点问答与学习诊断助手_升级版_多RAG_朴素贝叶斯诊断_0_6_0",
            "use_icon_as_answer_icon": False,
        },
        "dependencies": [],
        "kind": "app",
        "version": "0.6.0",
        "workflow": {
            "conversation_variables": [],
            "environment_variables": [],
            "features": {
                "file_upload": {
                    "allowed_file_extensions": [],
                    "allowed_file_types": ["document", "image"],
                    "allowed_file_upload_methods": ["local_file", "remote_url"],
                    "enabled": False,
                    "fileUploadConfig": {"audio_file_size_limit": 50, "batch_count_limit": 5, "file_size_limit": 15, "image_file_size_limit": 10, "video_file_size_limit": 100, "workflow_file_upload_limit": 10},
                    "image": {"enabled": False, "number_limits": 3, "transfer_methods": ["local_file", "remote_url"]},
                    "number_limits": 3,
                },
                "opening_statement": "",
                "retriever_resource": {"enabled": True},
                "sensitive_word_avoidance": {"enabled": False},
                "speech_to_text": {"enabled": False},
                "suggested_questions": [],
                "suggested_questions_after_answer": {"enabled": False},
                "text_to_speech": {"enabled": False, "language": "", "voice": ""},
            },
            "graph": {"edges": edges, "nodes": nodes},
        },
    }


def readme_md() -> str:
    return """# Dify 机器学习诊断工作流导入说明

## 文件清单

- `ml_learning_diagnosis_assistant_upgraded_0_6_0.yml`：升级后的 Dify 0.6.0 工作流 DSL。
- `knowledge_base/ml_keypoints.md`：课程知识点知识库。
- `knowledge_base/ml_quiz_bank.md`：题库、标准答案和评分点知识库。
- `knowledge_base/ml_misconceptions.md`：错因、易混淆点和评分标准知识库。

## Dify 导入顺序

1. 在 Dify 中新建或导入知识库“机器学习课程知识库”，上传 `ml_keypoints.md` 和 `ml_quiz_bank.md`。
2. 新建或导入知识库“机器学习错因与评分标准”，上传 `ml_misconceptions.md`。
3. 分段建议：400-600 tokens，重叠 50-100 tokens，top_k=5，score_threshold=0.30-0.45。
4. 导入 `ml_learning_diagnosis_assistant_upgraded_0_6_0.yml`。
5. 打开工作流，将 `课程知识库检索_RAG` 绑定到课程知识库，将 `错因知识库检索_RAG` 绑定到错因知识库。
6. 如果项目后端尚未实现 `/api/integrations/dify/diagnosis-callback`，请先在 Dify 中断开或修改 `项目数据库同步_HTTP节点`，否则运行时会尝试访问本地接口。

## 后端回调配置

工作流 HTTP 节点默认请求：

```http
POST http://127.0.0.1:5107/api/integrations/dify/diagnosis-callback
Authorization: Bearer change-me
Content-Type: application/json
```

项目侧建议环境变量：

```env
DIFY_BASE_URL=http://127.0.0.1/v1
DIFY_WORKFLOW_API_KEY=app-xxx
DIFY_WORKFLOW_USER_PREFIX=education-agent
DIFY_CALLBACK_TOKEN=change-me
```

## 节点结构

升级后共 13 个节点：

1. 开始
2. 输入清洗与任务识别_代码节点
3. 课程知识库检索_RAG
4. 错因知识库检索_RAG
5. RAG片段去重与证据整理_代码节点
6. 朴素贝叶斯知识点分类_代码节点
7. 掌握度评分_代码节点
8. LLM标准解释节点
9. 条件分支_问答或诊断
10. LLM诊断反馈节点
11. 输出结构化JSON_代码节点
12. 项目数据库同步_HTTP节点
13. 结束
"""


def main() -> None:
    KB_DIR.mkdir(parents=True, exist_ok=True)
    (KB_DIR / "ml_keypoints.md").write_text(topic_keypoints_md(), encoding="utf-8", newline="\n")
    (KB_DIR / "ml_quiz_bank.md").write_text(quiz_bank_md(), encoding="utf-8", newline="\n")
    (KB_DIR / "ml_misconceptions.md").write_text(misconceptions_md(), encoding="utf-8", newline="\n")
    workflow = workflow_yaml()
    (OUT_DIR / "ml_learning_diagnosis_assistant_upgraded_0_6_0.yml").write_text(
        yaml.safe_dump(workflow, allow_unicode=True, sort_keys=False, width=1000),
        encoding="utf-8",
        newline="\n",
    )
    (OUT_DIR / "README.md").write_text(readme_md(), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
