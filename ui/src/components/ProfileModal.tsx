import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  User,
  Shield,
  Key,
  Camera,
  Trash2,
  Check,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  Calendar,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { UserProfile, updateProfileName, updatePassword, uploadAvatar, deleteAvatar } from '../api';
import { formatAbsoluteTime } from '../utils/formatters';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  onProfileUpdated: (updated: UserProfile) => void;
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

type ProfileTab = 'profile' | 'security';

export const ProfileModal: React.FC<ProfileModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onProfileUpdated,
  onToast,
}) => {
  const [activeTab, setActiveTab] = useState<ProfileTab>('profile');

  // Nickname State
  const [name, setName] = useState(currentUser?.name || '');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // Avatar Upload State
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Password State
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPass, setShowCurrentPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      if (currentUser) {
        setName(currentUser.name || '');
      }
      setNameError(null);
      setAvatarError(null);
      setPasswordError(null);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => modalRef.current?.focus(), 40);
    }
  }, [isOpen, currentUser]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !currentUser) return null;

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setNameError('Nama atau nickname minimal 2 karakter.');
      return;
    }
    if (trimmed.length > 50) {
      setNameError('Nama atau nickname maksimal 50 karakter.');
      return;
    }

    setSavingName(true);
    setNameError(null);
    try {
      const updated = await updateProfileName(trimmed);
      onProfileUpdated(updated);
      onToast('Nickname berhasil diperbarui', 'success');
    } catch (err: any) {
      setNameError(err?.message || 'Gagal memperbarui nickname.');
    } finally {
      setSavingName(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setAvatarError('Ukuran file maksimal 2MB.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      setAvatarError('Format gambar harus berupa PNG, JPG, WebP, atau GIF.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setAvatarUploading(true);
    setAvatarError(null);
    try {
      const updated = await uploadAvatar(file);
      onProfileUpdated(updated);
      onToast('Foto profil berhasil diperbarui', 'success');
    } catch (err: any) {
      setAvatarError(err?.message || 'Gagal mengunggah foto profil.');
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteAvatar = async () => {
    if (!currentUser.avatar_url) return;
    setAvatarUploading(true);
    setAvatarError(null);
    try {
      const updated = await deleteAvatar();
      onProfileUpdated(updated);
      onToast('Foto profil dihapus', 'info');
    } catch (err: any) {
      setAvatarError(err?.message || 'Gagal menghapus foto profil.');
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword) {
      setPasswordError('Password saat ini wajib diisi.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('Password baru minimal 8 karakter.');
      return;
    }
    if (newPassword.length > 72) {
      setPasswordError('Password baru maksimal 72 karakter.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Konfirmasi password tidak cocok.');
      return;
    }
    if (currentPassword === newPassword) {
      setPasswordError('Password baru tidak boleh sama dengan password saat ini.');
      return;
    }

    setSavingPassword(true);
    setPasswordError(null);
    try {
      const res = await updatePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onToast(res.message || 'Password berhasil diperbarui', 'success');
    } catch (err: any) {
      setPasswordError(err?.message || 'Gagal memperbarui password.');
    } finally {
      setSavingPassword(false);
    }
  };

  const initialLetter = (currentUser.name || currentUser.email || 'U')
    .slice(0, 1)
    .toUpperCase();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
      <div
        ref={modalRef}
        tabIndex={-1}
        className="w-full max-w-lg bg-white border border-zinc-200/90 rounded-xl shadow-2xl overflow-hidden outline-none animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-modal-title"
      >
        {/* Modal Top Header */}
        <div className="px-5 py-4 border-b border-zinc-200/80 flex items-center justify-between shrink-0 bg-white">
          <div className="flex items-center gap-2.5">
            <div className="size-7 rounded-lg bg-zinc-100 border border-zinc-200 flex items-center justify-center text-zinc-800">
              <User className="w-4 h-4" />
            </div>
            <div>
              <h2 id="profile-modal-title" className="text-sm font-semibold text-zinc-950">
                Pengaturan Profil
              </h2>
              <p className="text-[11px] text-zinc-500">
                Kelola identitas akun dan keamanan kata sandi
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="size-7 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 transition-colors cursor-pointer"
            aria-label="Tutup modal profil"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation Pill Rail */}
        <div className="px-5 pt-3 pb-2 border-b border-zinc-100 bg-zinc-50/50 flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            className={`flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium transition-colors cursor-pointer ${
              activeTab === 'profile'
                ? 'bg-white text-zinc-950 shadow-2xs border border-zinc-200/90 font-semibold'
                : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            <span>Profil Pengguna</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('security')}
            className={`flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium transition-colors cursor-pointer ${
              activeTab === 'security'
                ? 'bg-white text-zinc-950 shadow-2xs border border-zinc-200/90 font-semibold'
                : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>Keamanan Akun</span>
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {activeTab === 'profile' && (
            <div className="space-y-5">
              {/* Avatar Section */}
              <div className="border border-zinc-200/90 rounded-lg p-4 bg-white shadow-2xs space-y-3">
                <span className="text-xs font-semibold text-zinc-950 block">Foto Profil</span>
                <div className="flex items-center gap-4">
                  <div className="relative size-16 rounded-full overflow-hidden border-2 border-zinc-200 bg-zinc-100 shrink-0 flex items-center justify-center">
                    {currentUser.avatar_url ? (
                      <img
                        src={currentUser.avatar_url}
                        alt={`Foto profil ${currentUser.name}`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-xl font-bold text-zinc-700 select-none">
                        {initialLetter}
                      </span>
                    )}

                    {avatarUploading && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 text-white animate-spin" />
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={handleFileChange}
                        className="hidden"
                        aria-label="Pilih file foto profil"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={avatarUploading}
                        className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-white hover:bg-zinc-50 border border-zinc-200/90 text-xs font-medium text-zinc-800 shadow-2xs transition-colors disabled:opacity-50 cursor-pointer"
                      >
                        <Camera className="w-3.5 h-3.5 text-zinc-500" />
                        <span>Ganti Foto</span>
                      </button>

                      {currentUser.avatar_url && (
                        <button
                          type="button"
                          onClick={handleDeleteAvatar}
                          disabled={avatarUploading}
                          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-white hover:bg-rose-50 border border-zinc-200/90 hover:border-rose-200/80 text-xs font-medium text-zinc-600 hover:text-rose-700 transition-colors disabled:opacity-50 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Hapus</span>
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] text-zinc-400">
                      Maksimal 2MB. Format didukung: PNG, JPG, WebP, GIF.
                    </p>
                  </div>
                </div>

                {avatarError && (
                  <div className="p-2.5 rounded-lg bg-rose-50/80 border border-rose-200/80 text-xs text-rose-700 flex items-center gap-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{avatarError}</span>
                  </div>
                )}
              </div>

              {/* Nickname & Account Information Form */}
              <form onSubmit={handleSaveName} className="space-y-3.5">
                <div className="border border-zinc-200/90 rounded-lg p-4 bg-white shadow-2xs space-y-3.5">
                  <span className="text-xs font-semibold text-zinc-950 block">Informasi Akun</span>

                  <div>
                    <label htmlFor="nickname-input" className="block text-xs font-medium text-zinc-700 mb-1">
                      Nama Lengkap / Nickname
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="nickname-input"
                        type="text"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Masukkan nama atau nickname"
                        className="flex-1 h-8 px-3 rounded-md border border-zinc-200 focus:border-zinc-900 bg-white text-xs text-zinc-950 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={savingName || name.trim() === currentUser.name}
                        className={`h-8 px-3 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0 ${
                          savingName || name.trim() === currentUser.name
                            ? 'bg-zinc-100 text-zinc-400 border border-zinc-200/80 cursor-not-allowed shadow-none'
                            : 'bg-zinc-900 hover:bg-zinc-800 text-white shadow-2xs cursor-pointer'
                        }`}
                      >
                        {savingName ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Check className="w-3.5 h-3.5" />
                        )}
                        <span>Simpan</span>
                      </button>
                    </div>
                    {nameError && (
                      <p className="text-[11px] text-rose-600 mt-1">{nameError}</p>
                    )}
                  </div>

                  {/* Read-Only Account Details */}
                  <div className="pt-2 border-t border-zinc-100 space-y-2 text-xs">
                    <div className="flex items-center justify-between text-zinc-600">
                      <div className="flex items-center gap-2 text-zinc-500">
                        <Mail className="w-3.5 h-3.5" />
                        <span>Alamat Email</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-zinc-900">
                        <span className="font-normal">{currentUser.email}</span>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-zinc-100 text-zinc-700 border border-zinc-200/80">
                          Terverifikasi
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-zinc-600">
                      <div className="flex items-center gap-2 text-zinc-500">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Peran Akses</span>
                      </div>
                      <span className="text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-md bg-zinc-100 text-zinc-700 border border-zinc-200/80">
                        {currentUser.role || 'viewer'}
                      </span>
                    </div>

                    {currentUser.created_at && (
                      <div className="flex items-center justify-between text-zinc-600">
                        <div className="flex items-center gap-2 text-zinc-500">
                          <Calendar className="w-3.5 h-3.5" />
                          <span>Terdaftar Sejak</span>
                        </div>
                        <span className="text-xs text-zinc-700 font-normal">
                          {formatAbsoluteTime(currentUser.created_at)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </form>
            </div>
          )}

          {activeTab === 'security' && (
            <form onSubmit={handleSavePassword} className="space-y-4 text-xs">
              <div className="border border-zinc-200/90 rounded-lg p-4 bg-white shadow-2xs space-y-3.5">
                <div>
                  <span className="text-xs font-semibold text-zinc-950 block">Ubah Password Akun</span>
                  <p className="text-[11px] text-zinc-500 mt-0.5">
                    Gunakan minimal 8 karakter dengan kombinasi angka dan huruf untuk keamanan maksimal.
                  </p>
                </div>

                {passwordError && (
                  <div className="p-2.5 rounded-lg bg-rose-50/80 border border-rose-200/80 text-xs text-rose-700 flex items-center gap-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{passwordError}</span>
                  </div>
                )}

                <div>
                  <label htmlFor="current-pass-input" className="block font-medium text-zinc-700 mb-1">
                    Password Saat Ini
                  </label>
                  <div className="relative">
                    <input
                      id="current-pass-input"
                      type={showCurrentPass ? 'text' : 'password'}
                      required
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="Masukkan password saat ini"
                      className="w-full h-8 pl-3 pr-9 rounded-md border border-zinc-200 focus:border-zinc-900 bg-white text-zinc-950 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrentPass(!showCurrentPass)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 cursor-pointer"
                      title={showCurrentPass ? 'Sembunyikan' : 'Tampilkan'}
                      aria-label="Tampilkan password saat ini"
                    >
                      {showCurrentPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="new-pass-input" className="block font-medium text-zinc-700 mb-1">
                    Password Baru
                  </label>
                  <div className="relative">
                    <input
                      id="new-pass-input"
                      type={showNewPass ? 'text' : 'password'}
                      required
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Minimal 8 karakter"
                      className="w-full h-8 pl-3 pr-9 rounded-md border border-zinc-200 focus:border-zinc-900 bg-white text-zinc-950 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPass(!showNewPass)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 cursor-pointer"
                      title={showNewPass ? 'Sembunyikan' : 'Tampilkan'}
                      aria-label="Tampilkan password baru"
                    >
                      {showNewPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="confirm-pass-input" className="block font-medium text-zinc-700 mb-1">
                    Konfirmasi Password Baru
                  </label>
                  <div className="relative">
                    <input
                      id="confirm-pass-input"
                      type={showConfirmPass ? 'text' : 'password'}
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Ketik ulang password baru"
                      className="w-full h-8 pl-3 pr-9 rounded-md border border-zinc-200 focus:border-zinc-900 bg-white text-zinc-950 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPass(!showConfirmPass)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 cursor-pointer"
                      title={showConfirmPass ? 'Sembunyikan' : 'Tampilkan'}
                      aria-label="Tampilkan konfirmasi password"
                    >
                      {showConfirmPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="pt-2 flex justify-end">
                  <button
                    type="submit"
                    disabled={savingPassword}
                    className={`flex items-center gap-1.5 h-8 px-4 rounded-md text-xs font-medium transition-colors ${
                      savingPassword
                        ? 'bg-zinc-100 text-zinc-400 border border-zinc-200/80 cursor-not-allowed shadow-none'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-white shadow-2xs cursor-pointer'
                    }`}
                  >
                    {savingPassword ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Key className="w-3.5 h-3.5" />
                    )}
                    <span>Perbarui Password</span>
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
export default ProfileModal;
