import mongoose from 'mongoose';

const studentSchema = new mongoose.Schema({
  region: { type: String, required: true, trim: true },
  district: { type: String, required: true, trim: true },
  locality: { type: String, required: true, trim: true },
  schoolType: { type: String, required: true, enum: ['Школа', 'Лицей', 'Гимназия', 'Другое'] },
  schoolName: { type: String, required: true, trim: true },
  grade: { type: String, required: true, trim: true },
  fullName: { type: String, required: true, trim: true }
}, { timestamps: true });

const attemptSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  answers: [{ questionIndex: Number, answerIndex: Number, isCorrect: Boolean }],
  completed: { type: Boolean, default: false },
  score: { type: Number, default: 0 },
  total: { type: Number, default: 10 },
  completedAt: Date
}, { timestamps: true });

export const Student = mongoose.model('Student', studentSchema);
export const Attempt = mongoose.model('Attempt', attemptSchema);
const topicSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  published: { type: Boolean, default: false },
  legacyModo: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const assignmentSchema = new mongoose.Schema({
  topic: { type: mongoose.Schema.Types.ObjectId, ref: 'Topic', default: null },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  passage: { type: String, default: '' },
  type: { type: String, enum: ['quiz', 'text', 'file', 'material'], default: 'text' },
  maxScore: { type: Number, default: 100 },
  published: { type: Boolean, default: true },
  questions: [{ text: String, options: [String], correctIndex: Number }],
  materialUrl: { type: String, default: '' },
  materialName: { type: String, default: '' }
}, { timestamps: true });

const submissionSchema = new mongoose.Schema({
  assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', required: true },
  topic: { type: mongoose.Schema.Types.ObjectId, ref: 'Topic', default: null },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  text: { type: String, default: '' },
  fileName: { type: String, default: '' },
  fileData: { type: String, default: '' },
  answers: [{ questionIndex: Number, answerIndex: Number, isCorrect: Boolean }],
  score: { type: Number, default: null },
  status: { type: String, enum: ['submitted', 'graded'], default: 'submitted' },
  comment: { type: String, default: '' },
  submittedAt: { type: Date, default: Date.now },
  gradedAt: Date,
  // Связь с исходной попыткой МОДО для безопасного импорта истории без дубликатов.
  legacyAttempt: { type: mongoose.Schema.Types.ObjectId, ref: 'Attempt', default: null },
  legacyOriginalScore: { type: Number, default: null },
  legacyOriginalTotal: { type: Number, default: null }
}, { timestamps: true });

export const Topic = mongoose.models.Topic || mongoose.model('Topic', topicSchema);
export const Assignment = mongoose.models.Assignment || mongoose.model('Assignment', assignmentSchema);
export const Submission = mongoose.models.Submission || mongoose.model('Submission', submissionSchema);
