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