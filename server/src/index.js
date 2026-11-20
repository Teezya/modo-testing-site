
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

import { Student, Attempt } from './models.js';
import { questions, publicTest } from './testData.js';

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

    const student = await Student.create(
      Object.fromEntries(
        fields.map(k => [k, String(req.body[k]).trim()])
      )
    );

    const attempt = await Attempt.create({
      student: student._id,
      total: questions.length
    });

    const token = makeToken({
      role: 'student',
      studentId: String(student._id),
      attemptId: String(attempt._id)
    });

    res.status(201).json({
      token,
      student: { fullName: student.fullName },
      attempt: { id: String(attempt._id) }
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
  .then(() => {
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
