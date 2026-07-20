import { PROJECT } from '../../config/projectConfig';

/**
 * Branding header — logo Kementerian PU + logo Surya Abadi + nama proyek ISWMP.
 */
export default function ProjectBrandHeader({ compact = false }) {
  const logoH = compact ? 'h-14' : 'h-16';

  return (
    <div className={`text-center ${compact ? 'mb-6' : 'mb-8'}`}>
      <div className="flex items-center justify-center gap-4 sm:gap-6">
        <div className="flex flex-col items-center gap-1.5">
          <img
            src={PROJECT.logoMinistry}
            alt={PROJECT.ministry}
            className={`${logoH} w-auto`}
          />
          <span className="text-[10px] font-medium text-gray-500 max-w-[88px] leading-tight">
            Kementerian PU
          </span>
        </div>

        <div className="h-12 w-px bg-gray-200" aria-hidden="true" />

        <div className="flex flex-col items-center gap-1.5">
          <img
            src={PROJECT.logoApp}
            alt={PROJECT.partnerBrand}
            className={`${logoH} w-auto rounded-lg object-contain`}
            onError={(e) => {
              e.currentTarget.onerror = null;
              e.currentTarget.src = PROJECT.logoAppFallback;
            }}
          />
          <span className="text-[10px] font-medium text-gray-500 max-w-[88px] leading-tight">
            {PROJECT.partnerBrand}
          </span>
        </div>
      </div>

      <div className={`${compact ? 'mt-4' : 'mt-5'} border-t border-gray-100 pt-4`}>
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
