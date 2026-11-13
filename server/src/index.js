import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Student, Attempt } from './models.js';
import { questions, publicTest } from './testData.js';

import dns from 'node:dns';

dns.setServers(['8.8.8.8', '8.8.4.4']);

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json());

const PORT = process.env.PORT || 5000;
const SECRET = process.env.JWT_SECRET || 'development-secret-change-me';

function makeToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: payload.role === 'admin' ? '8h' : '30d' });
}
function auth(role) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const data = jwt.verify(token, SECRET);
      if (role && data.role !== role) return res.status(403).json({ message: 'Недостаточно прав' });
      req.user = data;
      next();
    } catch {
      return res.status(401).json({ message: 'Сессия истекла. Войдите снова.' });
    }
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.post('/api/students/register', async (req, res) => {
  try {
    const fields = ['region','district','locality','schoolType','schoolName','grade','fullName'];
    for (const field of fields) {
      if (!String(req.body[field] || '').trim()) return res.status(400).json({ message: 'Заполните все поля.' });
    }
    const student = await Student.create(Object.fromEntries(fields.map(k => [k, String(req.body[k]).trim()])));
    const attempt = await Attempt.create({ student: student._id, total: questions.length });
    const token = makeToken({ role: 'student', studentId: String(student._id), attemptId: String(attempt._id) });
    res.status(201).json({ token, student: { fullName: student.fullName }, attempt: { id: String(attempt._id) } });
  } catch (e) {
    res.status(500).json({ message: 'Не удалось сохранить данные ученика.' });
  }
});

app.get('/api/test', auth('student'), async (req, res) => {
  const attempt = await Attempt.findById(req.user.attemptId);
  if (!attempt) return res.status(404).json({ message: 'Попытка не найдена.' });
  if (attempt.completed) return res.json({ completed: true, result: { score: attempt.score, total: attempt.total } });
  res.json({ ...publicTest(), answered: attempt.answers.length });
});

app.post('/api/test/answer', auth('student'), async (req, res) => {
  try {
    const { questionIndex, answerIndex } = req.body;
    const attempt = await Attempt.findById(req.user.attemptId);
    if (!attempt || attempt.completed) return res.status(400).json({ message: 'Тест уже завершён или не найден.' });
    if (questionIndex !== attempt.answers.length || questionIndex < 0 || questionIndex >= questions.length) {
      return res.status(409).json({ message: 'Нарушен порядок вопросов. Обновите страницу.' });
    }
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= 5) {
      return res.status(400).json({ message: 'Выберите вариант ответа.' });
    }
    const isCorrect = questions[questionIndex].correct === answerIndex;
    attempt.answers.push({ questionIndex, answerIndex, isCorrect });
    if (attempt.answers.length === questions.length) {
      attempt.completed = true;
      attempt.score = attempt.answers.filter(a => a.isCorrect).length;
      attempt.completedAt = new Date();
      await attempt.save();
      return res.json({ completed: true, result: { score: attempt.score, total: attempt.total, correct: attempt.score, incorrect: attempt.total - attempt.score } });
    }
    await attempt.save();
    res.json({ completed: false, nextIndex: attempt.answers.length });
  } catch {
    res.status(500).json({ message: 'Не удалось сохранить ответ.' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body;
  if (login !== process.env.ADMIN_LOGIN || password !== process.env.ADMIN_PASSWORD || !process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Неверный логин или пароль.' });
  }
  res.json({ token: makeToken({ role: 'admin' }) });
});

app.get('/api/admin/students', auth('admin'), async (_req, res) => {
  const attempts = await Attempt.find().populate('student').sort({ createdAt: -1 }).lean();
  res.json(attempts.filter(a => a.student).map(a => ({
    id: String(a._id), fullName: a.student.fullName, region: a.student.region,
    district: a.student.district, locality: a.student.locality, schoolType: a.student.schoolType,
    schoolName: a.student.schoolName, grade: a.student.grade,
    score: a.completed ? a.score : null, total: a.total,
    status: a.completed ? 'Завершён' : 'В процессе',
    createdAt: a.createdAt, completedAt: a.completedAt || null,
    answers: a.answers.map(x => ({ questionIndex: x.questionIndex, answerIndex: x.answerIndex, isCorrect: x.isCorrect }))
  })));
});

app.get('/api/admin/students/:id', auth('admin'), async (req, res) => {
  const a = await Attempt.findById(req.params.id).populate('student').lean();
  if (!a || !a.student) return res.status(404).json({ message: 'Ученик не найден.' });
  res.json({
    fullName: a.student.fullName, region: a.student.region, district: a.student.district,
    locality: a.student.locality, schoolType: a.student.schoolType, schoolName: a.student.schoolName,
    grade: a.student.grade, score: a.completed ? a.score : null, total: a.total,
    status: a.completed ? 'Завершён' : 'В процессе',
    answers: a.answers.map(x => ({ questionIndex: x.questionIndex, answerIndex: x.answerIndex, isCorrect: x.isCorrect }))
  });
});

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is missing. Add your MongoDB Atlas connection string to server/.env');
  process.exit(1);
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => app.listen(PORT, () => console.log(`API connected to MongoDB Atlas. API: http://localhost:${PORT}`)))
  .catch(err => { console.error('MongoDB Atlas connection error:', err.message); process.exit(1); });