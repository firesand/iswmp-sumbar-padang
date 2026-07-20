import { PROJECT } from '../../config/projectConfig';

/**
 * Branding header untuk Login / Register — logo Kementerian PU + nama proyek ISWMP.
 */
export default function ProjectBrandHeader({ compact = false }) {
  return (
    <div className={`text-center ${compact ? 'mb-6' : 'mb-8'}`}>
      <div className="flex justify-center">
        <img
          src={PROJECT.logoMinistry}
          alt={PROJECT.ministry}
          className={compact ? 'h-16 w-auto' : 'h-20 w-auto'}
          width={compact ? 72 : 90}
          height={compact ? 82 : 102}
        />
      </div>

      <p className={`${compact ? 'mt-3' : 'mt-4'} text-xs font-semibold uppercase tracking-wide text-green-800`}>
        {PROJECT.ministry}
      </p>
      <p className="text-[11px] text-gray-500 mt-0.5">
        Republik Indonesia
      </p>

      <div className={`${compact ? 'mt-3' : 'mt-4'} border-t border-gray-100 pt-4`}>
        <h1 className={`font-bold text-gray-900 ${compact ? 'text-2xl' : 'text-3xl'}`}>
          {PROJECT.name}
        </h1>
        <p className="mt-2 text-sm text-gray-600 leading-snug px-1">
          {PROJECT.description}
        </p>
        <p className="mt-1 text-xs text-gray-500 px-2">
          {PROJECT.fullName}
        </p>
      </div>
    </div>
  );
}
