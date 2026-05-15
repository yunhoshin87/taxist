// 관리자 공통 인증 체크 & 목업 데이터
function requireAdmin() {
  if (localStorage.getItem('adminAuth') !== 'true') {
    window.location.href = 'index.html';
  }
}

function logout() {
  localStorage.removeItem('adminAuth');
  localStorage.removeItem('adminName');
  window.location.href = 'index.html';
}

// 목업 회원 데이터
const MEMBERS = [
  {id:1, name:'김민준', email:'minjun.kim@seoul.go.kr', org:'서울지방국세청 법인세과', tax:['법인세','부가세'], status:'무료사용중', joinedAt:'2025-04-20', trialEndsAt:'2025-05-20', questions:18, lastLogin:'2025-05-14'},
  {id:2, name:'이수연', email:'suyeon.lee@incheon.go.kr', org:'인천세무서 재산세과', tax:['재산세'], status:'무료사용중', joinedAt:'2025-04-28', trialEndsAt:'2025-05-28', questions:7, lastLogin:'2025-05-13'},
  {id:3, name:'박정훈', email:'jh.park@busan.go.kr', org:'부산지방국세청 조사과', tax:['조사','법인세'], status:'무료기간만료', joinedAt:'2025-03-10', trialEndsAt:'2025-04-10', questions:34, lastLogin:'2025-05-10'},
  {id:4, name:'최유진', email:'yujin.choi@daegu.go.kr', org:'대구세무서 개인세과', tax:['개인세'], status:'무료사용중', joinedAt:'2025-05-01', trialEndsAt:'2025-06-01', questions:5, lastLogin:'2025-05-14'},
  {id:5, name:'정대원', email:'dw.jung@gwangju.go.kr', org:'광주세무서 징세과', tax:['징세','부가세'], status:'무료기간만료', joinedAt:'2025-03-05', trialEndsAt:'2025-04-05', questions:41, lastLogin:'2025-05-08'},
  {id:6, name:'한소희', email:'shhan@suwon.go.kr', org:'수원세무서 법인세과', tax:['법인세'], status:'무료사용중', joinedAt:'2025-05-10', trialEndsAt:'2025-06-10', questions:3, lastLogin:'2025-05-15'},
  {id:7, name:'임현서', email:'hs.lim@ulsan.go.kr', org:'울산세무서 부가세과', tax:['부가세'], status:'이용정지', joinedAt:'2025-04-01', trialEndsAt:'2025-05-01', questions:9, lastLogin:'2025-04-30'},
  {id:8, name:'오세준', email:'sj.oh@sejong.go.kr', org:'세종세무서 재산세과', tax:['재산세','개인세'], status:'무료사용중', joinedAt:'2025-05-12', trialEndsAt:'2025-06-12', questions:2, lastLogin:'2025-05-14'},
];

// 목업 질문 데이터
const QUESTIONS = [
  {id:1, userId:1, userName:'김민준', taxCategory:'법인세', title:'특수관계인 간 자산 양도 시 부당행위계산 부인 적용 요건 검토', status:'답변완료', createdAt:'2025-05-14 14:23', answerTime:'4분'},
  {id:2, userId:2, userName:'이수연', taxCategory:'재산세', title:'공동주택 가격 산정 이의신청 절차 및 감면 가능 여부', status:'답변완료', createdAt:'2025-05-14 11:05', answerTime:'6분'},
  {id:3, userId:4, userName:'최유진', taxCategory:'개인세', title:'비거주자의 국내 부동산 양도소득세 신고 방법', status:'답변완료', createdAt:'2025-05-13 16:42', answerTime:'5분'},
  {id:4, userId:1, userName:'김민준', taxCategory:'부가세', title:'용역 제공 시점과 세금계산서 발행 시기 불일치 문제', status:'검토필요', createdAt:'2025-05-13 09:17', answerTime:'3분'},
  {id:5, userId:3, userName:'박정훈', taxCategory:'조사', title:'세무조사 사전통지 생략 요건 및 절차 적정성 검토', status:'답변완료', createdAt:'2025-05-12 15:30', answerTime:'8분'},
  {id:6, userId:6, userName:'한소희', taxCategory:'법인세', title:'합병 시 이월결손금 승계 한도 계산 방법', status:'답변완료', createdAt:'2025-05-12 10:44', answerTime:'7분'},
  {id:7, userId:5, userName:'정대원', taxCategory:'징세', title:'압류 재산 공매 절차에서 우선채권자 순위 결정 기준', status:'오류신고', createdAt:'2025-05-11 14:00', answerTime:'5분'},
  {id:8, userId:8, userName:'오세준', taxCategory:'재산세', title:'과세기준일 현재 공부상 현황과 실질 현황 상이 시 과세 방법', status:'답변완료', createdAt:'2025-05-11 09:22', answerTime:'4분'},
  {id:9, userId:1, userName:'김민준', taxCategory:'법인세', title:'임원 퇴직금 한도 초과 시 손금 불산입 처리 방법', status:'답변완료', createdAt:'2025-05-10 16:55', answerTime:'6분'},
  {id:10, userId:2, userName:'이수연', taxCategory:'재산세', title:'신축 건물 과세표준 산정 기준 및 적용 세율', status:'답변완료', createdAt:'2025-05-09 11:30', answerTime:'3분'},
];

// 폴더 목업 데이터
const FOLDERS = [
  {id:1, name:'법인세', tax:'corporate_tax', color:'#3B5BDB', children:[
    {id:11, name:'기본업무', files:[
      {id:111, name:'법인세 기본 업무 처리 지침.md', size:'48KB', indexed:true, active:true, updatedAt:'2025-05-01'},
      {id:112, name:'소득처분 실무 가이드.md', size:'124KB', indexed:true, active:true, updatedAt:'2025-04-20'},
    ]},
    {id:12, name:'판례정리', files:[
      {id:121, name:'2024 세목별 최신 판례분석.md', size:'892KB', indexed:true, active:true, updatedAt:'2025-05-10'},
    ]},
    {id:13, name:'내부지침', files:[
      {id:131, name:'법인조정 내부 검토 기준.md', size:'67KB', indexed:false, active:true, updatedAt:'2025-04-15'},
    ]},
  ]},
  {id:2, name:'부가세', tax:'vat', color:'#0CA678', children:[
    {id:21, name:'신고', files:[
      {id:211, name:'부가가치세 신고 실무 매뉴얼.md', size:'215KB', indexed:true, active:true, updatedAt:'2025-05-05'},
    ]},
    {id:22, name:'환급', files:[
      {id:221, name:'환급 신청 절차 및 사례.md', size:'88KB', indexed:true, active:true, updatedAt:'2025-04-28'},
    ]},
  ]},
  {id:3, name:'조사', tax:'audit', color:'#F76707', children:[
    {id:31, name:'조사절차', files:[
      {id:311, name:'세무조사 절차 핸드북.md', size:'156KB', indexed:true, active:true, updatedAt:'2025-04-10'},
    ]},
  ]},
  {id:4, name:'징세', tax:'collection', color:'#E64980', children:[
    {id:41, name:'체납처분', files:[
      {id:411, name:'체납처분 실무 지침.md', size:'98KB', indexed:true, active:false, updatedAt:'2025-03-20'},
    ]},
  ]},
  {id:5, name:'재산세', tax:'property_tax', color:'#7048E8', children:[
    {id:51, name:'과세대상', files:[
      {id:511, name:'재산세 과세대상 판단 기준.md', size:'73KB', indexed:true, active:true, updatedAt:'2025-05-08'},
    ]},
  ]},
  {id:6, name:'개인세', tax:'individual_tax', color:'#1098AD', children:[
    {id:61, name:'양도', files:[
      {id:611, name:'양도소득세 계산 실무.md', size:'187KB', indexed:true, active:true, updatedAt:'2025-05-12'},
    ]},
  ]},
];

const STATUS_LABEL = {'무료사용중':'무료사용중','무료기간만료':'만료','결제사용중':'결제중','이용정지':'정지'};
const STATUS_COLOR = {'무료사용중':'green','무료기간만료':'orange','결제사용중':'blue','이용정지':'red'};
const Q_STATUS_COLOR = {'답변완료':'green','검토필요':'orange','오류신고':'red','재답변완료':'blue'};
