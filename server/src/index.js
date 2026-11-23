
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';

dns.setServers(['8.8.8.8', '8.8.4.4']);

// Поддерживаем .env как в корне проекта, так и в server/.env.
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(serverDir, '.env') });
dotenv.config({ path: path.resolve(serverDir, '..', '.env'), override: false });

import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  WidthType,
  AlignmentType
} from 'docx';

import { Student, Attempt, Topic, Assignment, Submission } from './models.js';
import { questions, publicTest, passage } from './testData.js';

const app = express();

const allowedOrigins = new Set([
  ...String(process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 5000;
const SECRET = process.env.JWT_SECRET;

function makeToken(payload) {
  return jwt.sign(payload, SECRET, {
    expiresIn: payload.role === 'admin' ? '8h' : '30d'
  });
}

function auth(role) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const data = jwt.verify(token, SECRET);

      if (role && data.role !== role) {
        return res.status(403).json({ message: 'Недостаточно прав' });
      }

      req.user = data;
      next();
    } catch {
      return res.status(401).json({
        message: 'Сессия истекла. Войдите снова.'
      });
    }
  };
}

// Проверка работоспособности API
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Регистрация ученика
app.post('/api/students/register', async (req, res) => {
  try {
    const fields = [
      'region',
      'district',
      'locality',
      'schoolType',
      'schoolName',
      'grade',
      'fullName'
    ];

    for (const field of fields) {
      if (!String(req.body[field] || '').trim()) {
        return res.status(400).json({
          message: 'Заполните все поля.'
        });
      }
    }

    const grade = String(req.body.grade).trim();
    if (!/^(?:[1-9]|1[01])(?:[АБВГД])?$/u.test(grade)) {
      return res.status(400).json({
        message: 'Выберите корректный класс от 1 до 11.'
      });
    }

    // Reuse an existing profile when the same full registration details are submitted.
    const profile = Object.fromEntries(fields.map(k => [k, String(req.body[k]).trim()]));
    const norm = value => String(value || '').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
    const candidates = await Student.find({ fullName: profile.fullName }).sort({ createdAt: 1 });
    let student = candidates.find(candidate => fields.every(k => norm(candidate[k]) === norm(profile[k])));
    const returning = Boolean(student);
    if (!student) student = await Student.create(profile);
    let attempt = await Attempt.findOne({ student: student._id, completed: false }).sort({ createdAt: -1 });
    if (!attempt) attempt = await Attempt.create({ student: student._id, total: questions.length });

    const token = makeToken({
      role: 'student',
      studentId: String(student._id),
      attemptId: String(attempt._id)
    });

    res.status(returning ? 200 : 201).json({
      token,
      student: { fullName: student.fullName },
      attempt: { id: String(attempt._id) },
      returning
    });
  } catch (e) {
    console.error('Student registration error:', e);
    res.status(500).json({
      message: 'Не удалось сохранить данные ученика.'
    });
  }
});

// Получение теста
app.get('/api/test', auth('student'), async (req, res) => {
  const attempt = await Attempt.findById(req.user.attemptId);

  if (!attempt) {
    return res.status(404).json({
      message: 'Попытка не найдена.'
    });
  }

  if (attempt.completed) {
    return res.json({
      completed: true,
      result: {
        score: attempt.score,
        total: attempt.total
      }
    });
  }

  res.json({
    ...publicTest(),
    answered: attempt.answers.length
  });
});

// Отправка ответа
app.post('/api/test/answer', auth('student'), async (req, res) => {
  try {
    const { questionIndex, answerIndex } = req.body;

    const attempt = await Attempt.findById(req.user.attemptId);

    if (!attempt || attempt.completed) {
      return res.status(400).json({
        message: 'Тест уже завершён или не найден.'
      });
    }

    if (
      questionIndex !== attempt.answers.length ||
      questionIndex < 0 ||
      questionIndex >= questions.length
    ) {
      return res.status(409).json({
        message: 'Нарушен порядок вопросов. Обновите страницу.'
      });
    }

    if (
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex >= 5
    ) {
      return res.status(400).json({
        message: 'Выберите вариант ответа.'
      });
    }

    const isCorrect = questions[questionIndex].correct === answerIndex;

    attempt.answers.push({
      questionIndex,
      answerIndex,
      isCorrect
    });

    if (attempt.answers.length === questions.length) {
      attempt.completed = true;
      attempt.score = attempt.answers.filter(a => a.isCorrect).length;
      attempt.completedAt = new Date();

      await attempt.save();

      return res.json({
        completed: true,
        result: {
          score: attempt.score,
          total: attempt.total,
          correct: attempt.score,
          incorrect: attempt.total - attempt.score
        }
      });
    }

    await attempt.save();

    res.json({
      completed: false,
      nextIndex: attempt.answers.length
    });
  } catch (e) {
    console.error('Answer error:', e);
    res.status(500).json({
      message: 'Не удалось сохранить ответ.'
    });
  }
});

// Вход администратора
app.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body;

  if (
    login !== process.env.ADMIN_LOGIN ||
    password !== process.env.ADMIN_PASSWORD ||
    !process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      message: 'Неверный логин или пароль.'
    });
  }

  res.json({
    token: makeToken({ role: 'admin' })
  });
});

// Список учеников
app.get('/api/admin/students', auth('admin'), async (_req, res) => {
  const attempts = await Attempt.find()
    .populate('student')
    .sort({ completed: -1, completedAt: -1, createdAt: -1 })
    .lean();

  // Для каждого ученика показываем последнюю завершённую попытку.
  // Если завершённых попыток нет — последнюю незавершённую.
  const latestByStudent = new Map();
  for (const attempt of attempts) {
    if (!attempt.student) continue;
    const studentId = String(attempt.student._id);
    if (!latestByStudent.has(studentId)) latestByStudent.set(studentId, attempt);
  }

  res.json(
    [...latestByStudent.values()]
      .map(a => ({
        id: String(a._id),
        fullName: a.student.fullName,
        region: a.student.region,
        district: a.student.district,
        locality: a.student.locality,
        schoolType: a.student.schoolType,
        schoolName: a.student.schoolName,
        grade: a.student.grade,
        score: a.completed ? a.score : null,
        total: a.total,
        status: a.completed ? 'Завершён' : 'В процессе',
        createdAt: a.createdAt,
        completedAt: a.completedAt || null,
        answers: a.answers.map(x => ({
          questionIndex: x.questionIndex,
          answerIndex: x.answerIndex,
          isCorrect: x.isCorrect
        }))
      }))
  );
});

// Подробная информация об ученике
app.get('/api/admin/students/:id', auth('admin'), async (req, res) => {
  const a = await Attempt.findById(req.params.id)
    .populate('student')
    .lean();

  if (!a || !a.student) {
    return res.status(404).json({
      message: 'Ученик не найден.'
    });
  }

  res.json({
    fullName: a.student.fullName,
    region: a.student.region,
    district: a.student.district,
    locality: a.student.locality,
    schoolType: a.student.schoolType,
    schoolName: a.student.schoolName,
    grade: a.student.grade,
    score: a.completed ? a.score : null,
    total: a.total,
    status: a.completed ? 'Завершён' : 'В процессе',
    answers: a.answers.map(x => ({
      questionIndex: x.questionIndex,
      answerIndex: x.answerIndex,
      isCorrect: x.isCorrect
    }))
  });
});

// Список уникальных классов
app.get('/api/admin/classes', auth('admin'), async (_req, res) => {
  try {
    const students = await Student.find().lean();
    const seen = new Map();

    for (const s of students) {
      const key = [
        s.region,
        s.district,
        s.locality,
        s.schoolType,
        s.schoolName,
        s.grade
      ].join('|||');

      if (!seen.has(key)) {
        seen.set(key, {
          key,
          region: s.region,
          district: s.district,
          locality: s.locality,
          schoolType: s.schoolType,
          schoolName: s.schoolName,
          grade: s.grade,
          studentCount: 0
        });
      }

      seen.get(key).studentCount++;
    }

    res.json(
      [...seen.values()].sort(
        (a, b) =>
          a.schoolName.localeCompare(b.schoolName, 'ru') ||
          a.grade.localeCompare(b.grade, 'ru')
      )
    );
  } catch (e) {
    console.error('Classes error:', e);
    res.status(500).json({
      message: 'Не удалось получить список классов.'
    });
  }
});

// Создание ячейки Word-таблицы
function cell(text, bold = false) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: String(text ?? '—'),
            bold,
            size: 20,
            font: 'Times New Roman'
          })
        ]
      })
    ]
  });
}

// Создание Word-таблицы
function makeTable(headers, rows) {
  return new Table({
    width: {
      size: 100,
      type: WidthType.PERCENTAGE
    },
    rows: [
      new TableRow({
        children: headers.map(h => cell(h, true)),
        tableHeader: true
      }),
      ...rows.map(row =>
        new TableRow({
          children: row.map(v => cell(v))
        })
      )
    ]
  });
}

// Формирование и отправка единого отчёта по классу
app.post('/api/admin/class-report', auth('admin'), async (req, res) => {
  try {
    const { key, action = 'download' } = req.body;

    if (!key || typeof key !== 'string') {
      return res.status(400).json({
        message: 'Выберите класс.'
      });
    }

    const parts = key.split('|||');

    if (parts.length !== 6) {
      return res.status(400).json({
        message: 'Некорректный идентификатор класса.'
      });
    }

    const [
      region,
      district,
      locality,
      schoolType,
      schoolName,
      grade
    ] = parts;

    const students = await Student.find({
      region,
      district,
      locality,
      schoolType,
      schoolName,
      grade
    }).lean();

    if (!students.length) {
      return res.status(404).json({
        message: 'В выбранном классе пока нет учеников.'
      });
    }

    const studentIds = students.map(s => s._id);

    const allCompletedAttempts = await Attempt.find({
      student: { $in: studentIds },
      completed: true
    })
      .populate('student')
      .sort({ completedAt: -1, createdAt: -1 })
      .lean();

    // В отчёт включаем только последнюю завершённую попытку каждого ученика.
    const latestCompletedByStudent = new Map();
    for (const attempt of allCompletedAttempts) {
      if (!attempt.student) continue;
      const studentId = String(attempt.student._id);
      if (!latestCompletedByStudent.has(studentId)) {
        latestCompletedByStudent.set(studentId, attempt);
      }
    }
    const attempts = [...latestCompletedByStudent.values()]
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    const totalQuestions = questions.length;
    const scores = attempts.map(a => a.score);

    const average = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0;

    const sortedScores = [...scores].sort((a, b) => a - b);

    const median = !sortedScores.length ? 0 : sortedScores.length % 2
      ? sortedScores[Math.floor(sortedScores.length / 2)]
      : (
          sortedScores[sortedScores.length / 2 - 1] +
          sortedScores[sortedScores.length / 2]
        ) / 2;

    const questionStats = questions.map((q, i) => {
      const answered = attempts
        .map(a => a.answers.find(x => x.questionIndex === i))
        .filter(Boolean);

      const correct = answered.filter(a => a.isCorrect).length;

      return [
        i + 1,
        q.text,
        answered.length,
        correct,
        answered.length - correct,
        answered.length
          ? `${Math.round(correct / answered.length * 100)}%`
          : '—'
      ];
    });

    const children = [
      new Paragraph({
        text: 'ОТЧЁТ ПО РЕЗУЛЬТАТАМ ТЕСТИРОВАНИЯ',
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER
      }),

      new Paragraph({
        text: `${schoolType} «${schoolName}» · ${grade} класс`,
        alignment: AlignmentType.CENTER
      }),

      new Paragraph({
        text: `${locality}, ${district}, ${region}`,
        alignment: AlignmentType.CENTER
      }),

      new Paragraph({
        text: `Дата формирования: ${new Date().toLocaleDateString('ru-RU')}`
      }),

      new Paragraph({
        text: '1. Общая информация',
        heading: HeadingLevel.HEADING_1
      }),

      makeTable(
        ['Показатель', 'Значение'],
        [
          ['Всего зарегистрировано учеников', students.length],
          ['Завершили тестирование', attempts.length],
          ['Не завершили тестирование', students.length - attempts.length],
          ['Средний балл', `${average.toFixed(2)} из ${totalQuestions}`],
          ['Средний результат', `${(average / totalQuestions * 100).toFixed(1)}%`],
          ['Максимальный результат', `${scores.length ? Math.max(...scores) : 0} из ${totalQuestions}`],
          ['Минимальный результат', `${scores.length ? Math.min(...scores) : 0} из ${totalQuestions}`],
          ['Медианный результат', `${median} из ${totalQuestions}`]
        ]
      ),

      new Paragraph({
        text: '2. Сводная таблица результатов учеников',
        heading: HeadingLevel.HEADING_1
      }),

      makeTable(
        ['№', 'ФИО', 'Баллы', 'Правильно', 'Ошибки', 'Результат'],
        attempts.map((a, i) => [
          i + 1,
          a.student.fullName,
          `${a.score}/${a.total}`,
          a.score,
          a.total - a.score,
          `${Math.round(a.score / a.total * 100)}%`
        ])
      ),

      new Paragraph({
        text: '3. Статистика по вопросам',
        heading: HeadingLevel.HEADING_1
      }),

      makeTable(
        ['№', 'Вопрос', 'Ответили', 'Верно', 'Ошибки', 'Верно, %'],
        questionStats
      )
    ];

    children.push(
      new Paragraph({
        text: '4. Подробные результаты каждого ученика',
        heading: HeadingLevel.HEADING_1
      })
    );

    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];

      children.push(
        new Paragraph({
          text: `${i + 1}. ${a.student.fullName}`,
          heading: HeadingLevel.HEADING_2,
          pageBreakBefore: true
        })
      );

      children.push(
        new Paragraph({
          text:
            `Результат: ${a.score} из ${a.total} ` +
            `(${Math.round(a.score / a.total * 100)}%). ` +
            `Дата: ${a.completedAt
              ? new Date(a.completedAt).toLocaleString('ru-RU')
              : '—'}`
        })
      );

      const detailRows = questions.map((q, qi) => {
        const ans = a.answers.find(x => x.questionIndex === qi);

        return [
          qi + 1,
          q.text,
          ans
            ? `${'АБВГД'[ans.answerIndex]}. ${q.options[ans.answerIndex]}`
            : 'Нет ответа',
          `${'АБВГД'[q.correct]}. ${q.options[q.correct]}`,
          ans?.isCorrect ? 'Верно' : 'Неверно'
        ];
      });

      children.push(
        makeTable(
          ['№', 'Вопрос', 'Ответ ученика', 'Правильный ответ', 'Результат'],
          detailRows
        )
      );
    }

    children.push(
      new Paragraph({
        text: '5. Аналитический вывод',
        heading: HeadingLevel.HEADING_1
      })
    );

    const hardest = [...questionStats]
      .sort(
        (a, b) =>
          Number(String(a[5]).replace('%', '') || 0) -
          Number(String(b[5]).replace('%', '') || 0)
      )
      .slice(0, 3);

    children.push(
      new Paragraph({
        text:
          `В тестировании завершили работу ${attempts.length} ` +
          `из ${students.length} зарегистрированных учеников. ` +
          `Средний результат составил ` +
          `${(average / totalQuestions * 100).toFixed(1)}%. ` +
          `Наименьшая доля правильных ответов отмечена по вопросам: ` +
          `${hardest.map(x => `${x[0]} (${x[5]})`).join(', ')}. ` +
          `Выводы основаны только на фактических ответах участников.`
      })
    );

    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: 900,
                right: 850,
                bottom: 900,
                left: 850
              }
            }
          },
          children
        }
      ]
    });

    const buffer = await Packer.toBuffer(doc);

    const safe = (schoolName + '_' + grade)
      .replace(/[^\p{L}\p{N}_-]+/gu, '_');

    const filename = `MODO_Class_${safe}.docx`;

    // Отправка через Brevo API вместо SMTP
    if (action === 'email') {
      const required = [
        'BREVO_API_KEY',
        'SMTP_FROM',
        'TEACHER_EMAIL'
      ];

      const missing = required.filter(k => !process.env[k]);

      if (missing.length) {
        return res.status(503).json({
          message:
            `Не настроена отправка через Brevo API: ${missing.join(', ')}`
        });
      }

      const brevoResponse = await fetch(
        'https://api.brevo.com/v3/smtp/email',
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'api-key': process.env.BREVO_API_KEY,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            sender: {
              email: process.env.SMTP_FROM
            },
            to: [
              {
                email: process.env.TEACHER_EMAIL
              }
            ],
            subject: `МОДО — отчёт ${schoolName}, ${grade}`,
            textContent:
              `Во вложении сводный отчёт по классу ${grade}. ` +
              `Завершили тестирование: ${attempts.length} из ${students.length}.`,
            attachment: [
              {
                name: filename,
                content: buffer.toString('base64')
              }
            ]
          })
        }
      );

      if (!brevoResponse.ok) {
        const details = await brevoResponse.text();

        console.error(
          'Brevo API error:',
          brevoResponse.status,
          details
        );

        return res.status(502).json({
          message:
            'Brevo не смог отправить письмо. ' +
            'Проверьте API Key и подтверждение адреса отправителя.'
        });
      }

      return res.json({
        message: `Отчёт отправлен на ${process.env.TEACHER_EMAIL}`,
        completed: attempts.length,
        registered: students.length
      });
    }

    // Скачивание Word-документа
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    );

    res.send(buffer);

  } catch (e) {
    console.error('Class report error:', e);

    res.status(500).json({
      message: 'Не удалось сформировать отчёт класса.'
    });
  }
});

// ===== МНОГОТЕМНАЯ УЧЕБНАЯ ПЛАТФОРМА =====
// Создаём тему старого теста один раз, не затрагивая существующие попытки.
app.get('/api/learning/standalone-assignments', auth('student'), async (req, res) => {
  try {
    const assignments = await Assignment.find({ topic: null, published: true, type: 'quiz' }).sort({ createdAt: -1 }).lean();
    const submissions = await Submission.find({ student: req.user.studentId, assignment: { $in: assignments.map(a => a._id) } }).lean();
    res.json(assignments.map(a => {
      const sub = submissions.find(x => String(x.assignment) === String(a._id));
      return { id: String(a._id), title: a.title, passage: a.passage || '', description: a.description || '', total: (a.questions || []).length, status: sub?.status || 'not_started', score: sub?.score ?? null };
    }));
  } catch (e) { console.error(e); res.status(500).json({ message: 'Не удалось загрузить задания.' }); }
});

app.get('/api/learning/topics', auth('student'), async (req, res) => {
  try {
    const topics = await Topic.find({ published: true }).sort({ createdAt: 1 }).lean();
    const assignments = await Assignment.find({ published: true }).lean();
    const submissions = await Submission.find({ student: req.user.studentId }).lean();
    const data = topics.map(topic => {
      const tasks = assignments.filter(a => String(a.topic) === String(topic._id));
      const done = tasks.filter(a => submissions.some(s => String(s.assignment) === String(a._id) && s.status === 'graded'));
      const scored = done.filter(a => submissions.find(s => String(s.assignment) === String(a._id))?.score !== null);
      const earned = scored.reduce((sum, a) => sum + (submissions.find(s => String(s.assignment) === String(a._id))?.score || 0), 0);
      const possible = scored.reduce((sum, a) => sum + (a.maxScore || 100), 0);
      return { id: String(topic._id), title: topic.title, description: topic.description, legacyModo: topic.legacyModo,
        total: tasks.length, completed: done.length, percent: tasks.length ? Math.round(done.length / tasks.length * 100) : 0,
        score: possible ? Math.round(earned / possible * 100) : null, assignments: tasks.map(a => ({ id: String(a._id), title: a.title, type: a.type, maxScore: a.maxScore,
          status: submissions.find(s => String(s.assignment) === String(a._id))?.status || 'not_started', score: submissions.find(s => String(s.assignment) === String(a._id))?.score ?? null })) };
    });
    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Не удалось загрузить темы.' }); }
});

app.get('/api/learning/assignments/:id', auth('student'), async (req, res) => {
  try {
    const a = await Assignment.findOne({ _id: req.params.id, published: true }).lean();
    if (!a) return res.status(404).json({ message: 'Задание не найдено.' });
    const previous = await Submission.findOne({ assignment: a._id, student: req.user.studentId }).lean();
    // Явно возвращаем текст чтения: он хранится отдельно от краткого описания задания.
    const passage = [a.passage, a.readingText, a.sourceText, a.materialText]
      .find(value => typeof value === 'string' && value.trim()) || '';
    res.set('Cache-Control', 'no-store');
    res.json({
      ...a,
      id: String(a._id),
      topicId: a.topic ? String(a.topic) : null,
      passage,
      description: a.description || a.instructions || '',
      questions: Array.isArray(a.questions) ? a.questions.map(q => ({ text: q.text, options: q.options })) : [],
      previous: previous ? { text: previous.text, status: previous.status, score: previous.score, comment: previous.comment } : null
    });
  } catch (e) {
    console.error('Assignment load error:', e);
    res.status(500).json({ message: 'Не удалось загрузить задание.' });
  }
});

app.post('/api/learning/assignments/:id/submit', auth('student'), async (req, res) => {
  try {
    const a = await Assignment.findOne({ _id: req.params.id, published: true });
    if (!a) return res.status(404).json({ message: 'Задание не найдено.' });
    const fileData = String(req.body.fileData || '');
    if (fileData.length > 8 * 1024 * 1024) return res.status(413).json({ message: 'Файл слишком большой. Максимальный размер — около 6 МБ.' });
    let payload = { assignment: a._id, ...(a.topic ? { topic: a.topic } : {}), student: req.user.studentId, text: String(req.body.text || ''), fileName: String(req.body.fileName || '').slice(0, 255), fileData, status: 'submitted', score: null };
    if (a.type === 'quiz') {
      const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
      if (answers.length !== a.questions.length) return res.status(400).json({ message: 'Ответьте на все вопросы.' });
      payload.answers = answers.map((answerIndex, questionIndex) => ({ questionIndex, answerIndex, isCorrect: Number(answerIndex) === Number(a.questions[questionIndex].correctIndex) }));
      payload.score = payload.answers.filter(x => x.isCorrect).length;
      payload.status = 'graded';
      payload.gradedAt = new Date();
    } else if (a.type === 'text' && !payload.text.trim()) return res.status(400).json({ message: 'Введите ответ.' });
    else if (a.type === 'file' && !payload.fileData) return res.status(400).json({ message: 'Прикрепите файл.' });
    const saved = await Submission.findOneAndUpdate({ assignment: a._id, student: req.user.studentId }, payload, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ message: a.type === 'quiz' ? 'Тест проверен автоматически.' : 'Ответ отправлен на проверку.', status: saved.status, score: saved.score });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Не удалось отправить работу.' }); }
});

// Администратор: темы и задания
// Самостоятельные задания без обязательного создания тем.
app.get('/api/admin/assignments', auth('admin'), async (_req, res) => {
  const rows = await Assignment.find({ topic: null }).sort({ createdAt: -1 }).lean();
  res.json(rows.map(a => ({ ...a, id: String(a._id) })));
});
app.post('/api/admin/assignments', auth('admin'), async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const passageText = String(req.body.passage || '').trim();
    const qs = Array.isArray(req.body.questions) ? req.body.questions.map(q => ({
      text: String(q.text || '').trim(),
      options: Array.isArray(q.options) ? q.options.map(x => String(x).trim()).slice(0, 5) : [],
      correctIndex: Number(q.correctIndex)
    })) : [];
    if (!title || !passageText) return res.status(400).json({ message: 'Укажите название задания и текст для чтения.' });
    if (!qs.length || qs.some(q => !q.text || q.options.length !== 5 || q.options.some(x => !x) || !Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 4)) return res.status(400).json({ message: 'В каждом вопросе должно быть 5 заполненных вариантов и один правильный ответ.' });
    const a = await Assignment.create({ topic: null, title, passage: passageText, description: String(req.body.description || ''), type: 'quiz', questions: qs, maxScore: qs.length, published: req.body.published === true });
    res.status(201).json({ id: String(a._id), title: a.title, published: a.published });
  } catch (e) { console.error('Standalone assignment create error:', e); res.status(500).json({ message: 'Не удалось создать задание.' }); }
});
app.put('/api/admin/assignments/:id', auth('admin'), async (req, res) => {
  try {
    const a = await Assignment.findOne({ _id: req.params.id, topic: null });
    if (!a) return res.status(404).json({ message: 'Задание не найдено.' });
    const title = String(req.body.title || '').trim();
    const passageText = String(req.body.passage || '').trim();
    const qs = Array.isArray(req.body.questions) ? req.body.questions.map(q => ({ text: String(q.text || '').trim(), options: Array.isArray(q.options) ? q.options.map(x => String(x).trim()).slice(0, 5) : [], correctIndex: Number(q.correctIndex) })) : [];
    if (!title || !passageText || !qs.length || qs.some(q => !q.text || q.options.length !== 5 || q.options.some(x => !x) || !Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 4)) return res.status(400).json({ message: 'Проверьте название, текст и все вопросы с пятью вариантами.' });
    a.title = title; a.passage = passageText; a.description = String(req.body.description || ''); a.questions = qs; a.maxScore = qs.length;
    if (req.body.published !== undefined) a.published = !!req.body.published;
    await a.save(); res.json({ id: String(a._id), title: a.title, published: a.published });
  } catch (e) { console.error('Standalone assignment update error:', e); res.status(500).json({ message: 'Не удалось сохранить изменения.' }); }
});
app.delete('/api/admin/assignments/:id', auth('admin'), async (req, res) => {
  const a = await Assignment.findOne({ _id: req.params.id, topic: null });
  if (!a) return res.status(404).json({ message: 'Задание не найдено.' });
  await Submission.deleteMany({ assignment: a._id }); await a.deleteOne(); res.json({ ok: true });
});

app.get('/api/admin/assignments/:id/report', auth('admin'), async (req, res) => {
  try {
    const assignment = await Assignment.findOne({ _id: req.params.id, topic: null }).lean();
    if (!assignment) return res.status(404).json({ message: 'Задание не найдено.' });
    const students = await Student.find().sort({ schoolName: 1, grade: 1, fullName: 1 }).lean();
    const submissions = await Submission.find({ assignment: assignment._id }).lean();
    const rows = students.map((student, index) => {
      const sub = submissions.find(x => String(x.student) === String(student._id));
      return [index + 1, student.fullName, `${student.schoolName}, ${student.grade}`, sub ? `${sub.score ?? '—'}/${assignment.questions.length}` : 'Не приступал', sub ? new Date(sub.submittedAt).toLocaleString('ru-RU') : '—'];
    });
    const doc = new Document({ sections: [{ children: [
      new Paragraph({ text: `Отчёт по заданию: ${assignment.title}`, heading: HeadingLevel.TITLE }),
      new Paragraph({ text: `Вопросов: ${assignment.questions.length}. Учеников: ${students.length}.` }),
      makeTable(['№', 'Ученик', 'Школа / класс', 'Результат', 'Дата отправки'], rows)
    ] }] });
    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('MODO_assignment_report.docx')}`);
    res.send(buffer);
  } catch (e) { console.error('Assignment report error:', e); res.status(500).json({ message: 'Не удалось сформировать отчёт.' }); }
});

app.get('/api/admin/topics', auth('admin'), async (_req, res) => {
  const topics = await Topic.find().sort({ createdAt: -1 }).lean();
  const assignments = await Assignment.find().lean();
  res.json(topics.map(t => ({ ...t, id: String(t._id), assignments: assignments.filter(a => String(a.topic) === String(t._id)).map(a => ({ ...a, id: String(a._id) })) })));
});
app.post('/api/admin/topics', auth('admin'), async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ message: 'Укажите название темы.' });
  const topic = await Topic.create({ title, description: String(req.body.description || ''), published: !!req.body.published });
  res.status(201).json({ id: String(topic._id), title: topic.title });
});
app.patch('/api/admin/topics/:id', auth('admin'), async (req, res) => {
  const update = {};
  if (req.body.title !== undefined) update.title = String(req.body.title).trim();
  if (req.body.description !== undefined) update.description = String(req.body.description);
  if (req.body.published !== undefined) update.published = !!req.body.published;
  const topic = await Topic.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!topic) return res.status(404).json({ message: 'Тема не найдена.' });
  res.json({ id: String(topic._id), title: topic.title, published: topic.published });
});
app.delete('/api/admin/topics/:id', auth('admin'), async (req, res) => {
  const topic = await Topic.findById(req.params.id);
  if (!topic) return res.status(404).json({ message: 'Тема не найдена.' });
  await Assignment.deleteMany({ topic: topic._id });
  await Submission.deleteMany({ topic: topic._id });
  await topic.deleteOne();
  res.json({ ok: true });
});
app.post('/api/admin/topics/:id/assignments', auth('admin'), async (req, res) => {
  const topic = await Topic.findById(req.params.id);
  if (!topic) return res.status(404).json({ message: 'Тема не найдена.' });
  const title = String(req.body.title || '').trim();
  const type = ['quiz', 'text', 'file', 'material'].includes(req.body.type) ? req.body.type : 'text';
  if (!title) return res.status(400).json({ message: 'Укажите название задания.' });
  const questionsData = type === 'quiz' && Array.isArray(req.body.questions) ? req.body.questions.map(q => ({ text: String(q.text || ''), options: Array.isArray(q.options) ? q.options.map(String).slice(0, 6) : [], correctIndex: Number(q.correctIndex) })) : [];
  if (type === 'quiz' && (!questionsData.length || questionsData.some(q => !q.text || q.options.length < 2 || q.correctIndex < 0 || q.correctIndex >= q.options.length))) return res.status(400).json({ message: 'Проверьте вопросы и правильные ответы.' });
  const a = await Assignment.create({ topic: topic._id, title, description: String(req.body.description || ''), type, maxScore: Number(req.body.maxScore) || (type === 'quiz' ? questionsData.length : 100), questions: questionsData, materialUrl: String(req.body.materialUrl || ''), materialName: String(req.body.materialName || ''), published: req.body.published !== false });
  res.status(201).json({ id: String(a._id), title: a.title });
});
app.patch('/api/admin/assignments/:id', auth('admin'), async (req, res) => {
  const a = await Assignment.findByIdAndUpdate(req.params.id, { $set: { published: !!req.body.published } }, { new: true });
  if (!a) return res.status(404).json({ message: 'Задание не найдено.' });
  res.json({ id: String(a._id), published: a.published });
});
app.get('/api/admin/classes/:key/progress', auth('admin'), async (req, res) => {
  try {
    const parts = decodeURIComponent(req.params.key).split('|||');
    if (parts.length !== 6) return res.status(400).json({ message: 'Некорректный класс.' });
    const [region, district, locality, schoolType, schoolName, grade] = parts;
    const students = await Student.find({ region, district, locality, schoolType, schoolName, grade }).lean();
    const topics = await Topic.find().sort({ createdAt: 1 }).lean();
    const assignments = await Assignment.find().lean();
    const submissions = await Submission.find({ student: { $in: students.map(s => s._id) } }).sort({ submittedAt: -1 }).lean();
    const oldAttempts = await Attempt.find({ student: { $in: students.map(s => s._id) } }).sort({ completedAt: -1, createdAt: -1 }).lean();
    const topicRows = topics.map(t => ({ id: String(t._id), title: t.title }));
    const studentRows = students.map(student => ({
      id: String(student._id), fullName: student.fullName,
      topics: topics.map(topic => {
        const tasks = assignments.filter(a => String(a.topic) === String(topic._id) && a.type !== 'material');
        const taskRows = tasks.map(task => {
          const sub = submissions.find(x => String(x.student) === String(student._id) && String(x.assignment) === String(task._id));
          const maxScore = Number(task.maxScore || 100);
          const isDone = !!sub;
          const isGraded = sub?.status === 'graded' && sub.score !== null;
          return {
            id: String(task._id), title: task.title, type: task.type,
            status: !sub ? 'not_started' : isGraded ? 'graded' : 'submitted',
            statusLabel: !sub ? 'Не начато' : isGraded ? 'Проверено' : 'На проверке',
            done: isDone, score: sub?.score ?? null, maxScore,
            percent: isGraded ? Math.round((Number(sub.score) / maxScore) * 100) : null,
            submittedAt: sub?.submittedAt || null, gradedAt: sub?.gradedAt || null,
            comment: sub?.comment || '', text: sub?.text || '', fileName: sub?.fileName || '',
            answers: sub?.answers || []
          };
        });
        const graded = taskRows.filter(x => x.status === 'graded');
        const earned = graded.reduce((n, x) => n + Number(x.score || 0), 0);
        const maximum = graded.reduce((n, x) => n + Number(x.maxScore || 0), 0);
        const submitted = taskRows.filter(x => x.done).length;
        const percent = maximum ? Math.round(earned / maximum * 100) : null;
        const legacyAttempts = oldAttempts.filter(a => String(a.student) === String(student._id) && a.completed);
        return {
          id: String(topic._id), title: topic.title,
          completed: submitted, graded: graded.length, total: tasks.length,
          status: !tasks.length ? 'no_tasks' : submitted === 0 ? 'not_started' : submitted < tasks.length ? 'in_progress' : graded.length === tasks.length ? 'completed' : 'pending_review',
          statusLabel: !tasks.length ? 'Нет заданий' : submitted === 0 ? 'Не начато' : submitted < tasks.length ? 'В процессе' : graded.length === tasks.length ? 'Все проверено' : 'Ожидает проверки',
          score: percent, earned, maximum, assignments: taskRows,
          legacyResult: topic.legacyModo && legacyAttempts.length ? { score: legacyAttempts[0].score, total: legacyAttempts[0].total, completedAt: legacyAttempts[0].completedAt } : null
        };
      })
    }));
    res.json({ class: { region, district, locality, schoolType, schoolName, grade }, topics: topicRows, students: studentRows });
  } catch (e) {
    console.error('Class progress error:', e);
    res.status(500).json({ message: 'Не удалось загрузить успеваемость класса.' });
  }
});
app.post('/api/admin/topics/:id/report', auth('admin'), async (req, res) => {
  try {
    const { action = 'download', classKey = '' } = req.body || {};
    const topic = await Topic.findById(req.params.id).lean();
    if (!topic) return res.status(404).json({ message: 'Тема не найдена.' });
    let studentFilter = {};
    if (classKey) {
      const parts = String(classKey).split('|||');
      if (parts.length !== 6) return res.status(400).json({ message: 'Некорректный класс.' });
      const [region, district, locality, schoolType, schoolName, grade] = parts;
      studentFilter = { region, district, locality, schoolType, schoolName, grade };
    }
    const students = await Student.find(studentFilter).sort({ fullName: 1 }).lean();
    const assignments = await Assignment.find({ topic: topic._id, type: { $ne: 'material' } }).sort({ createdAt: 1 }).lean();
    const submissions = await Submission.find({ topic: topic._id, student: { $in: students.map(s => s._id) } }).sort({ submittedAt: -1 }).lean();
    const rows = students.map(student => {
      const taskResults = assignments.map(task => {
        const sub = submissions.find(x => String(x.student) === String(student._id) && String(x.assignment) === String(task._id));
        const status = !sub ? 'Не начато' : sub.status === 'graded' && sub.score !== null ? 'Проверено' : 'На проверке';
        return { title: task.title, status, score: sub?.score ?? null, max: task.maxScore || 100, percent: sub?.status === 'graded' && sub.score !== null ? Math.round(Number(sub.score) / Number(task.maxScore || 100) * 100) : null, submittedAt: sub?.submittedAt, comment: sub?.comment || '' };
      });
      const graded = taskResults.filter(x => x.percent !== null);
      const max = graded.reduce((n, x) => n + x.max, 0);
      const earned = graded.reduce((n, x) => n + Number(x.score || 0), 0);
      return { student, taskResults, submitted: taskResults.filter(x => x.status !== 'Не начато').length, total: assignments.length, earned, max, percent: max ? Math.round(earned / max * 100) : null };
    });
    const doc = new Document({ sections: [{ children: [
      new Paragraph({ text: `Отчёт по теме: ${topic.title}`, heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: `Дата формирования: ${new Date().toLocaleString('ru-RU')}` }),
      ...(classKey ? [new Paragraph({ text: `Класс: ${students[0]?.schoolName || ''}, ${students[0]?.grade || ''}` })] : []),
      new Paragraph({ text: `Учеников: ${students.length}. Заданий в теме: ${assignments.length}.` }),
      makeTable(['Ученик', 'Выполнено', 'Оценка', 'Статус'], rows.map(r => [r.student.fullName, `${r.submitted}/${r.total}`, r.percent === null ? 'Нет оценки' : `${r.percent}% (${r.earned}/${r.max})`, r.submitted === 0 ? 'Не приступал' : r.submitted < r.total ? 'Не всё выполнено' : r.percent === null ? 'Ожидает проверки' : 'Завершено'])),
      ...rows.flatMap(r => [new Paragraph({ text: r.student.fullName, heading: HeadingLevel.HEADING_2 }), makeTable(['Задание', 'Статус', 'Баллы', 'Процент', 'Комментарий'], r.taskResults.map(t => [t.title, t.status, t.score === null ? '—' : `${t.score}/${t.max}`, t.percent === null ? '—' : `${t.percent}%`, t.comment || '—']))])
    ] }] });
    const buffer = await Packer.toBuffer(doc);
    const filename = `MODO_${topic.title.replace(/[^\p{L}\p{N}_-]+/gu, '_')}_report.docx`;
    if (action === 'email') {
      const reportRecipient = process.env.ADMIN_EMAIL || process.env.TEACHER_EMAIL;
      if (!process.env.BREVO_API_KEY || !reportRecipient || !process.env.SMTP_FROM) return res.status(400).json({ message: 'Для отправки настройте BREVO_API_KEY, SMTP_FROM и ADMIN_EMAIL (или TEACHER_EMAIL) в .env.' });
      const mail = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: { email: process.env.SMTP_FROM }, to: [{ email: reportRecipient }], subject: `Отчёт МОДО: ${topic.title}`, textContent: `Во вложении отчёт по теме «${topic.title}».`, attachment: [{ name: filename, content: buffer.toString('base64') }] }) });
      if (!mail.ok) { const detail = await mail.text(); console.error('Brevo topic report error:', detail); return res.status(502).json({ message: 'Не удалось отправить письмо через Brevo.' }); }
      return res.json({ message: `Отчёт по теме отправлен на ${reportRecipient}.` });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (e) {
    console.error('Topic report error:', e);
    res.status(500).json({ message: 'Не удалось сформировать отчёт по теме.' });
  }
});

app.get('/api/admin/topics/:id/submissions', auth('admin'), async (req, res) => {
  const rows = await Submission.find({ topic: req.params.id }).populate('student').populate('assignment').sort({ submittedAt: -1 }).lean();
  res.json(rows.filter(x => x.student && x.assignment).map(x => ({ id: String(x._id), student: x.student.fullName, assignment: x.assignment.title, type: x.assignment.type, text: x.text, fileName: x.fileName, score: x.score, status: x.status, comment: x.comment })));
});
app.patch('/api/admin/submissions/:id/grade', auth('admin'), async (req, res) => {
  const score = Number(req.body.score);
  if (!Number.isFinite(score) || score < 0) return res.status(400).json({ message: 'Укажите корректный балл.' });
  const sub = await Submission.findById(req.params.id).populate('assignment');
  if (!sub) return res.status(404).json({ message: 'Работа не найдена.' });
  if (score > (sub.assignment?.maxScore || 100)) return res.status(400).json({ message: 'Балл выше максимального.' });
  sub.score = score; sub.comment = String(req.body.comment || ''); sub.status = 'graded'; sub.gradedAt = new Date(); await sub.save();
  res.json({ ok: true, score: sub.score });
});

// Проверка MongoDB
const requiredEnv = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_LOGIN', 'ADMIN_PASSWORD'];
const missingEnv = requiredEnv.filter(name => !process.env[name]);

if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  console.error('Place your existing .env in the project root or in server/.env.');
  process.exit(1);
}

// Запуск сервера
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    // Первоначальная тема со старым тестом: создаётся один раз, не удаляет старые данные.
    const legacy = await Topic.findOne({ legacyModo: true });
    let legacyTopic = legacy;
    if (!legacyTopic) {
      legacyTopic = await Topic.create({ title: 'МОДО — Рынок труда и профессии будущего', description: 'Исходный тест МОДО и материалы по теме', published: true, legacyModo: true });
    }
    // У темы старого теста должна быть одна связанная карточка задания.
    let legacyAssignment = await Assignment.findOne({ topic: legacyTopic._id, type: 'quiz', title: 'Исходный тест МОДО' });
    if (!legacyAssignment) {
      legacyAssignment = await Assignment.create({ topic: legacyTopic._id, title: 'Исходный тест МОДО', description: 'Тест «Рынок труда и профессии будущего» из первоначальной версии платформы.', passage, type: 'quiz', questions: questions.map(q => ({ text: q.text, options: q.options, correctIndex: q.correct })), maxScore: questions.length, published: true });
    }

    if (!legacyAssignment.passage) { legacyAssignment.passage = passage; await legacyAssignment.save(); }

    // Идемпотентный импорт: для каждого ученика берём последнюю завершённую
    // старую попытку. Исходные Attempts не изменяем и не удаляем.
    const legacyAttempts = await Attempt.find({ completed: true }).sort({ completedAt: -1, createdAt: -1 }).lean();
    const latestByStudent = new Map();
    for (const attempt of legacyAttempts) {
      const studentId = String(attempt.student);
      if (!latestByStudent.has(studentId)) latestByStudent.set(studentId, attempt);
    }
    let importedLegacyCount = 0;
    for (const attempt of latestByStudent.values()) {
      const alreadyImported = await Submission.findOne({ legacyAttempt: attempt._id }).select('_id').lean();
      if (alreadyImported) continue;
      const originalTotal = Number(attempt.total || legacyAssignment.maxScore || questions.length);
      const originalScore = Number(attempt.score || 0);
      const targetMax = Number(legacyAssignment.maxScore || questions.length);
      const normalizedScore = originalTotal > 0 ? Math.round((originalScore / originalTotal) * targetMax * 100) / 100 : 0;
      await Submission.create({
        assignment: legacyAssignment._id,
        topic: legacyTopic._id,
        student: attempt.student,
        answers: Array.isArray(attempt.answers) ? attempt.answers.map((answer, index) => ({
          questionIndex: Number(answer.questionIndex ?? index),
          answerIndex: Number(answer.answerIndex ?? -1),
          isCorrect: Boolean(answer.isCorrect)
        })) : [],
        score: Math.max(0, Math.min(targetMax, normalizedScore)),
        status: 'graded',
        submittedAt: attempt.completedAt || attempt.updatedAt || attempt.createdAt || new Date(),
        gradedAt: attempt.completedAt || attempt.updatedAt || attempt.createdAt || new Date(),
        legacyAttempt: attempt._id,
        legacyOriginalScore: originalScore,
        legacyOriginalTotal: originalTotal,
        comment: 'Импортировано из истории старого теста МОДО.'
      });
      importedLegacyCount += 1;
    }
    console.log(`Legacy MODO history migration: ${importedLegacyCount} new result(s) imported; ${latestByStudent.size} latest completed attempt(s) found.`);

    app.listen(PORT, () => {
      console.log(
        `API connected to MongoDB Atlas. API: http://localhost:${PORT}`
      );
    });
  })
  .catch(err => {
    console.error(
      'MongoDB Atlas connection error:',
      err.message
    );

    process.exit(1);
  });
