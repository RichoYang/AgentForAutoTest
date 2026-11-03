// Preserve history for reference resolution without turning every ancestor into
// another acceptance target. A new question has its own root user message.
export const currentUserQuestion=job=>job.currentQuestion??job.originalQuestion??job.instruction??'';
export function fieldMappingContract(job){
 const text=currentUserQuestion(job);
 if(!/字段(?:名|映射|对应)|(?:数据库|表).{0,12}字段|\b(?:field|column)\s+(?:names?|mapping)\b/i.test(text))return null;
 const runtimeRequested=/(?:已上线|已部署|线上实际|实际(?:页面|表单).{0,12}(?:取值|保存|读取)|核实.{0,10}(?:表单|流程).{0,10}(?:实现|落地))|\b(?:deployed|runtime)\b/i.test(text);
 return {kind:'field_mapping',runtimeBindingExplicitlyRequested:runtimeRequested,
  policy:'按用户字段清单对照已核实的实际库表/列、接口/当前身份、生成值、计算值或真正未知项。先识别附件是运行界面、空白模板还是字段需求稿；空白模板的字段来源对照不以找到已部署的同名审批流程/模板实例为前提。SQL列及注释证明物理结构，不自动证明业务角色等价。建议映射须明确标注建议/条件，不冒充已实现；计算项没有直接物理列时按图中已给公式和已证实来源说明，不擅自补业务口径。只有用户明确要求运行时绑定/实现核验时才以该项为必需；原图真实未映射字段仍如实保留，不能仅改颜色宣称完成。'};
}
