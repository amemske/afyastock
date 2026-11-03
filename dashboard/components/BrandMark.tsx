/** AfyaStock mark: a medicine box with a health cross. Original artwork. */
export default function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#0b6e8a" />
      <path d="M8 12.5 16 8l8 4.5v9L16 26l-8-4.5z" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M16 13.2v7.2M12.4 16.8h7.2" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
