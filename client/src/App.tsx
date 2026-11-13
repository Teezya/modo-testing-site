import { useEffect, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, GraduationCap, LockKeyhole, LogOut } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000';
type Question = { text: string; options: string[] };
type Result = { score: number; total: number; correct: number; incorrect: number };
type ClassRow = { key:string; region:string; district:string; locality:string; schoolType:string; schoolName:string; grade:string; studentCount:number };
type StudentRow = { id:string; fullName:string; region:string; district:string; locality:string; schoolType:string; schoolName:string; grade:string; score:number|null; total:number; status:string; createdAt:string; completedAt:string|null };
const letters = ['А','Б','В','Г','Д'];

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const f=()=>setPath(location.pathname); window.addEventListener('popstate',f); return()=>window.removeEventListener('popstate',f); }, []);
  return path.startsWith('/admin') ? <Admin/> : <StudentApp/>;
}
function StudentApp() {
  const [token,setToken] = useState(localStorage.getItem('modo_student_token') || '');
  const [studentName,setStudentName] = useState(localStorage.getItem('modo_student_name') || '');
  const [passage,setPassage] = useState('');
  const [questions,setQuestions] = useState<Question[]>([]);
  const [index,setIndex] = useState(0);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [result,setResult] = useState<Result|null>(null);
  const [phase,setPhase] = useState<'loading'|'register'|'test'|'result'>('loading');
  const [visible,setVisible] = useState(true);

  useEffect(() => {
    if (!token) { setPhase('register'); return; }
    fetch(`${API}/api/test`,{headers:{Authorization:`Bearer ${token}`}})
      .then(async r=>{const d=await r.json(); if(!r.ok) throw Error(d.message); return d;})
      .then(d=>{
        if(d.completed){setResult({score:d.result.score,total:d.result.total,correct:d.result.score,incorrect:d.result.total-d.result.score});setPhase('result');}
        else {setPassage(d.passage);setQuestions(d.questions);setIndex(d.answered||0);setPhase('test');}
      }).catch(()=>{localStorage.removeItem('modo_student_token');setToken('');setPhase('register');});
  },[token]);

  async function register(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError('');
    const form = new FormData(e.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      const r=await fetch(`${API}/api/students/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const d=await r.json(); if(!r.ok) throw Error(d.message);
      localStorage.setItem('modo_student_token',d.token); localStorage.setItem('modo_student_name',d.student.fullName);
      setStudentName(d.student.fullName); setToken(d.token);
    } catch(e:any){setError(e.message||'Ошибка регистрации');}
    finally{setBusy(false);}
  }
  async function answer(answerIndex:number) {
    if(busy || !questions[index]) return;
    setBusy(true); setError('');
    try {
      const r=await fetch(`${API}/api/test/answer`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({questionIndex:index,answerIndex})});
      const d=await r.json(); if(!r.ok) throw Error(d.message);
      setVisible(false);
      setTimeout(()=>{
        if(d.completed){setResult(d.result);setPhase('result');}
        else setIndex(d.nextIndex);
        setVisible(true);setBusy(false);
      },420);
    } catch(e:any){setError(e.message||'Не удалось отправить ответ');setBusy(false);}
  }
  if(phase==='loading') return <Shell><div className="loader">Загрузка…</div></Shell>;
  if(phase==='register') return <Shell><div className="form-card">
    <div className="brand"><span className="brand-icon"><GraduationCap size={22}/></span><span>МОДО <small>Тестирование</small></span></div>
    <div className="eyebrow">ПЕРЕД НАЧАЛОМ</div><h1>Данные ученика</h1><p className="muted">Заполните информацию, чтобы начать тестирование.</p>
    <form onSubmit={register} className="form-grid">
      <label>Область<input name="region" placeholder="Например, Акмолинская" required/></label>
      <label>Район<input name="district" placeholder="Название района" required/></label>
      <label>Село или город<input name="locality" placeholder="Название населённого пункта" required/></label>
      <label>Тип учебного заведения<select name="schoolType" required defaultValue=""><option value="" disabled>Выберите</option><option>Школа</option><option>Лицей</option><option>Гимназия</option><option>Другое</option></select></label>
      <label className="wide">Название школы<input name="schoolName" placeholder="Полное название школы" required/></label>
      <label>Класс<input name="grade" placeholder="Например, 9А" required/></label>
      <label>ФИО<input name="fullName" placeholder="Фамилия Имя Отчество" required/></label>
      {error&&<div className="error wide">{error}</div>}
      <button className="primary wide" disabled={busy}>{busy?'Сохранение…':'Начать тест'} <ArrowRight size={18}/></button>
    </form>
  </div></Shell>;
  if(phase==='result' && result) return <Shell><div className="result-card">
    <div className="success-mark"><Check size={30}/></div><div className="eyebrow">ТЕСТ ЗАВЕРШЁН</div><h1>Ваш результат</h1><p className="muted">{studentName}</p>
    <div className="score">{result.score}<span> / {result.total}</span></div>
    <div className="score-label">Набранные баллы</div>
    <div className="result-stats"><div><b>{result.correct}</b><span>Правильных</span></div><div><b>{result.incorrect}</b><span>Неправильных</span></div><div><b>{Math.round(result.score/result.total*100)}%</b><span>Результат</span></div></div>
  </div></Shell>;
  const q=questions[index];
  return <Shell><div className="test-wrap">
    <header className="test-header"><div className="brand"><span className="brand-icon"><GraduationCap size={22}/></span><span>МОДО <small>Тестирование</small></span></div><div className="student-chip">{studentName}</div></header>
    <div className="progress-row"><span>Вопрос {index+1} из {questions.length}</span><span>{Math.round(index/questions.length*100)}%</span></div>
    <div className="progress-track"><div style={{width:`${index/questions.length*100}%`}}/></div>
    <div className="test-layout">
      <section className="passage-card"><div className="eyebrow">ТЕКСТ ДЛЯ ЧТЕНИЯ</div><h2>Рынок труда и профессии будущего</h2><div className="passage">{passage}</div></section>
      <section className={`question-card ${visible?'enter':'leave'}`}>
        <div className="eyebrow">ВОПРОС {index+1}</div><h2>{q?.text}</h2>
        <div className="answers">{q?.options.map((opt,i)=><button key={`${index}-${i}`} className="answer" disabled={busy} onClick={()=>answer(i)}><span className="letter">{letters[i]}</span><span>{opt}</span><ArrowRight className="answer-arrow" size={17}/></button>)}</div>
        {error&&<div className="error">{error}</div>}
        <div className="hint">Выберите один вариант ответа. Переход произойдёт автоматически.</div>
      </section>
    </div>
  </div></Shell>;
}
function Shell({children}:{children:React.ReactNode}) {return <main className="page-shell">{children}<footer>Система тестирования МОДО</footer></main>}

function Admin() {
  const [token,setToken]=useState(sessionStorage.getItem('modo_admin_token')||'');
  const [login,setLogin]=useState(''); const [password,setPassword]=useState('');
  const [rows,setRows]=useState<StudentRow[]>([]); const [classes,setClasses]=useState<ClassRow[]>([]); const [selectedClass,setSelectedClass]=useState(''); const [reportBusy,setReportBusy]=useState(false); const [notice,setNotice]=useState(''); const [error,setError]=useState(''); const [loading,setLoading]=useState(false);
  async function load(t:string) {
    setLoading(true);setError('');
    try {const r=await fetch(`${API}/api/admin/students`,{headers:{Authorization:`Bearer ${t}`}});const d=await r.json();if(!r.ok)throw Error(d.message);setRows(d);}
    catch(e:any){setError(e.message);sessionStorage.removeItem('modo_admin_token');setToken('');}
    finally{setLoading(false);}
  }
  useEffect(()=>{if(token){load(token);fetch(`${API}/api/admin/classes`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json()).then(d=>{setClasses(Array.isArray(d)?d:[]);if(Array.isArray(d)&&d.length)setSelectedClass(d[0].key);}).catch(()=>{});}},[token]);
  async function signIn(e:React.FormEvent){e.preventDefault();setLoading(true);setError('');try{const r=await fetch(`${API}/api/admin/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login,password})});const d=await r.json();if(!r.ok)throw Error(d.message);sessionStorage.setItem('modo_admin_token',d.token);setToken(d.token);}catch(e:any){setError(e.message);}finally{setLoading(false);}}
  async function classReport(action:'download'|'email') {
    if(!selectedClass)return;setReportBusy(true);setError('');setNotice('');
    try { const r=await fetch(`${API}/api/admin/class-report`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({key:selectedClass,action})});
      if(!r.ok){const d=await r.json();throw Error(d.message||'Ошибка формирования отчёта');}
      if(action==='email'){const d=await r.json();setNotice(d.message);}
      else {const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='MODO_Отчёт_класса.docx';a.click();URL.revokeObjectURL(url);setNotice('Word-отчёт сформирован и скачан.');}
    } catch(e:any){setError(e.message||'Не удалось выполнить действие');} finally{setReportBusy(false);}
  }
  if(!token) return <Shell><div className="login-card"><div className="brand"><span className="brand-icon"><LockKeyhole size={21}/></span><span>Администрирование</span></div><h1>Вход в панель</h1><form onSubmit={signIn} className="form-grid one"><label>Логин<input value={login} onChange={e=>setLogin(e.target.value)} required/></label><label>Пароль<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>{error&&<div className="error">{error}</div>}<button className="primary" disabled={loading}>{loading?'Вход…':'Войти'}</button></form></div></Shell>;
  return <main className="admin-page"><header className="admin-header"><div className="brand"><span className="brand-icon"><GraduationCap size={22}/></span><span>МОДО <small>Админ-панель</small></span></div><button className="ghost" onClick={()=>{sessionStorage.removeItem('modo_admin_token');setToken('');}}><LogOut size={16}/> Выйти</button></header>
    <div className="admin-content"><div className="admin-title"><div><div className="eyebrow">РЕЗУЛЬТАТЫ ТЕСТИРОВАНИЯ</div><h1>Ученики</h1></div><button className="ghost" onClick={()=>load(token)}>Обновить</button></div>
      <section className="table-card" style={{padding:20,marginBottom:20}}><div className="table-heading"><h2>Отчёт по классу</h2><span>Один общий Word-документ</span></div><p className="muted">Выберите школу и класс. В документ попадут общая статистика и подробные ответы каждого ученика, завершившего тест.</p><label style={{display:'block',margin:'14px 0'}}>Класс<select value={selectedClass} onChange={e=>setSelectedClass(e.target.value)} style={{width:'100%',padding:12,marginTop:6}}><option value="">Выберите класс</option>{classes.map(c=><option key={c.key} value={c.key}>{c.schoolName} · {c.grade} · {c.locality} ({c.studentCount} уч.)</option>)}</select></label><div style={{display:'flex',gap:10,flexWrap:'wrap'}}><button className="primary" disabled={!selectedClass||reportBusy} onClick={()=>classReport('download')}>{reportBusy?'Формирование…':'Скачать Word-отчёт'}</button><button className="ghost" disabled={!selectedClass||reportBusy} onClick={()=>classReport('email')}>Отправить учителю на email</button></div>{notice&&<div className="success-message" style={{marginTop:12}}>{notice}</div>}{error&&<div className="error" style={{marginTop:12}}>{error}</div>}</section>
      <div className="stat-grid"><div className="stat-card"><span>Всего участников</span><b>{rows.length}</b></div><div className="stat-card"><span>Завершили тест</span><b>{rows.filter(r=>r.status==='Завершён').length}</b></div><div className="stat-card"><span>Средний балл</span><b>{rows.filter(r=>r.score!==null).length ? (rows.filter(r=>r.score!==null).reduce((s,r)=>s+(r.score||0),0)/rows.filter(r=>r.score!==null).length).toFixed(1) : '—'}</b></div></div>
      {error&&<div className="error">{error}</div>}
      <div className="table-card"><div className="table-heading"><h2>Список учеников</h2><span>{loading?'Загрузка…':`${rows.length} записей`}</span></div>
        <div className="table-scroll"><table><thead><tr><th>ФИО</th><th>Область / район</th><th>Село / город</th><th>Школа</th><th>Класс</th><th>Баллы</th><th>Статус</th></tr></thead><tbody>
        {rows.map(r=><tr key={r.id}><td className="name-cell">{r.fullName}</td><td>{r.region}, {r.district}</td><td>{r.locality}</td><td>{r.schoolType}: {r.schoolName}</td><td>{r.grade}</td><td><b>{r.score===null?'—':`${r.score} / ${r.total}`}</b></td><td><span className={`status ${r.status==='Завершён'?'done':''}`}>{r.status}</span></td></tr>)}
        {!rows.length&&!loading&&<tr><td colSpan={7} className="empty">Пока нет зарегистрированных учеников</td></tr>}
        </tbody></table></div>
      </div>
    </div>
  </main>;
}
export default App;