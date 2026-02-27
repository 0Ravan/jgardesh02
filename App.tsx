import React, { useState, useCallback, useRef } from 'react';
import { Upload, Calculator, FileSpreadsheet, AlertCircle, CheckCircle2, Download, Loader2 } from 'lucide-react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

interface ParsedCSV {
  data: any[];
  headers: string[];
}

interface ProcessingResult {
  success: boolean;
  message?: string;
}

function App() {
  const [files, setFiles] = useState<{
    open?: File;
    purch?: File;
    ret?: File;
    sales?: File;
  }>({});
  
  const [targetSales, setTargetSales] = useState<number>(720343738661);
  const [targetTax, setTargetTax] = useState<number>(30574390776);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const downloadLinkRef = useRef<HTMLAnchorElement>(null);

  const handleFileUpload = useCallback((type: 'open' | 'purch' | 'ret' | 'sales') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFiles(prev => {
        const isNew = !prev[type];
        if (isNew) setUploadedCount(c => c + 1);
        return { ...prev, [type]: file };
      });
    }
  }, []);

  const parseCSV = (file: File): Promise<ParsedCSV> => {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        encoding: 'UTF-8',
        skipEmptyLines: true,
        complete: (results) => {
          const headers = results.meta.fields || [];
          resolve({ data: results.data as any[], headers });
        },
        error: (error) => reject(error),
      });
    });
  };

  const groupBySum = (data: any[], groupCol: string, sumCol: string): Map<string, number> => {
    const result = new Map<string, number>();
    data.forEach(row => {
      const key = String(row[groupCol] || '');
      const val = parseFloat(row[sumCol]) || 0;
      if (key) {
        result.set(key, (result.get(key) || 0) + val);
      }
    });
    return result;
  };

  const processData = async () => {
    if (!files.open || !files.purch || !files.ret || !files.sales) {
      setResult({ success: false, message: '❌ خطا: لطفاً هر ۴ فایل را آپلود کنید.' });
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      // Load all CSVs
      const [dfOpen, dfPurch, dfRet, dfSales] = await Promise.all([
        parseCSV(files.open),
        parseCSV(files.purch),
        parseCSV(files.ret),
        parseCSV(files.sales),
      ]);

      // Column names
      const COL_S_CODE = 'کد کالا';
      const COL_S_QTY = 'تعداد واحد جز';
      const COL_S_TAX_PCT = 'درصد مالیات';
      const COL_S_TOTAL = 'فروش';
      const COL_S_TAX_AMT = 'جمع مالیات سطر';

      // Get quantity column for inventory files
      const getQtyCol = (df: ParsedCSV): string => {
        const possible = ['تعداد واحد جز', 'تعداد', 'مانده تعدادی'];
        for (const p of possible) {
          const found = df.headers.find(h => h.trim() === p);
          if (found) return found;
        }
        return df.headers[1];
      };

      // Calculate inventory
      const openQtyCol = getQtyCol(dfOpen);
      const purchQtyCol = getQtyCol(dfPurch);
      const retQtyCol = getQtyCol(dfRet);

      const openSum = groupBySum(dfOpen.data, COL_S_CODE, openQtyCol);
      const purchSum = groupBySum(dfPurch.data, COL_S_CODE, purchQtyCol);
      const retSum = groupBySum(dfRet.data, COL_S_CODE, retQtyCol);

      // Get unique codes
      const allCodes = new Set([
        ...openSum.keys(),
        ...purchSum.keys(),
        ...retSum.keys(),
        ...dfSales.data.map(r => r[COL_S_CODE]).filter(Boolean),
      ]);

      // Create inventory map
      const inventory = new Map<string, any>();
      allCodes.forEach(code => {
        const q_open = openSum.get(code) || 0;
        const q_purch = purchSum.get(code) || 0;
        const q_ret = retSum.get(code) || 0;
        inventory.set(code, {
          code,
          q_open,
          q_purch,
          q_ret,
          available: q_open + q_purch - q_ret,
        });
      });

      // Aggregate sales data
      const salesAgg = new Map<string, { qty: number; total: number; tax: number; tax_pct: number }>();
      const taxMap = new Map<string, number>();

      dfSales.data.forEach(row => {
        const code = String(row[COL_S_CODE] || '');
        if (!code) return;

        const qty = parseFloat(row[COL_S_QTY]) || 0;
        const total = parseFloat(row[COL_S_TOTAL]) || 0;
        const tax = parseFloat(row[COL_S_TAX_AMT]) || 0;
        const taxPct = parseFloat(row[COL_S_TAX_PCT]) || 0;

        if (!salesAgg.has(code)) {
          salesAgg.set(code, { qty: 0, total: 0, tax: 0, tax_pct: taxPct });
        }
        const agg = salesAgg.get(code)!;
        agg.qty += qty;
        agg.total += total;
        agg.tax += tax;
        
        if (!taxMap.has(code)) {
          taxMap.set(code, taxPct);
        }
      });

      // Merge inventory with sales
      const finalData: any[] = [];
      allCodes.forEach(code => {
        const inv = inventory.get(code);
        const sales = salesAgg.get(code) || { qty: 0, total: 0, tax: 0, tax_pct: 0 };
        const ending = (inv?.available || 0) - sales.qty;
        
        finalData.push({
          code,
          q_open: inv?.q_open || 0,
          q_purch: inv?.q_purch || 0,
          q_ret: inv?.q_ret || 0,
          available: inv?.available || 0,
          [COL_S_QTY]: sales.qty,
          [COL_S_TOTAL]: sales.total,
          [COL_S_TAX_AMT]: sales.tax,
          [COL_S_TAX_PCT]: taxMap.get(code) || 0,
          ending,
        });
      });

      // Algorithm: distribute negative inventory
      const taxGroups = [...new Set(finalData.map(r => r[COL_S_TAX_PCT]))];
      
      taxGroups.forEach(taxGrp => {
        const grpIndices = finalData
          .map((r, i) => ({ ...r, index: i }))
          .filter(r => r[COL_S_TAX_PCT] === taxGrp);
        
        const negItems = grpIndices.filter(r => r.ending < 0);
        const posItems = grpIndices.filter(r => r.ending > 0 && r[COL_S_TOTAL] > 0);

        if (negItems.length > 0 && posItems.length > 0) {
          // Calculate deficit ratios
          let totalMoveQty = 0;
          let totalMoveSales = 0;
          let totalMoveTax = 0;

          negItems.forEach(item => {
            const deficitRatio = Math.min(1.0, Math.abs(item.ending) / (item[COL_S_QTY] || 1));
            const moveQty = item[COL_S_QTY] * deficitRatio;
            const moveSales = item[COL_S_TOTAL] * deficitRatio;
            const moveTax = item[COL_S_TAX_AMT] * deficitRatio;

            totalMoveQty += moveQty;
            totalMoveSales += moveSales;
            totalMoveTax += moveTax;

            // Subtract from negative items
            finalData[item.index][COL_S_QTY] -= moveQty;
            finalData[item.index][COL_S_TOTAL] -= moveSales;
            finalData[item.index][COL_S_TAX_AMT] -= moveTax;
          });

          // Add to positive items based on weights
          const totalPosSales = posItems.reduce((sum, item) => sum + item[COL_S_TOTAL], 0);
          
          posItems.forEach(item => {
            const weight = item[COL_S_TOTAL] / totalPosSales;
            finalData[item.index][COL_S_QTY] += weight * totalMoveQty;
            finalData[item.index][COL_S_TOTAL] += weight * totalMoveSales;
            finalData[item.index][COL_S_TAX_AMT] += weight * totalMoveTax;
          });
        }
      });

      // Final targeting
      const totalSales = finalData.reduce((sum, r) => sum + r[COL_S_TOTAL], 0);
      const salesRatio = totalSales > 0 ? targetSales / totalSales : 1;

      finalData.forEach(r => {
        r['فروش_نهایی'] = Math.floor(r[COL_S_TOTAL] * salesRatio);
      });

      const currentTotalSales = finalData.reduce((sum, r) => sum + r['فروش_نهایی'], 0);
      const salesDiff = targetSales - currentTotalSales;
      if (salesDiff !== 0) {
        const maxIdx = finalData.reduce((maxIdx, r, i, arr) => 
          r['فروش_نهایی'] > arr[maxIdx]['فروش_نهایی'] ? i : maxIdx, 0);
        finalData[maxIdx]['فروش_نهایی'] += salesDiff;
      }

      // Tax targeting
      const taxableItems = finalData.filter(r => r[COL_S_TAX_PCT] > 0);
      const totalTax = taxableItems.reduce((sum, r) => sum + r[COL_S_TAX_AMT], 0);
      const taxRatio = totalTax > 0 ? targetTax / totalTax : 1;

      finalData.forEach(r => {
        if (r[COL_S_TAX_PCT] > 0) {
          r['مالیات_نهایی'] = Math.floor(r[COL_S_TAX_AMT] * taxRatio);
        } else {
          r['مالیات_نهایی'] = 0;
        }
      });

      const currentTotalTax = finalData.reduce((sum, r) => sum + r['مالیات_نهایی'], 0);
      const taxDiff = targetTax - currentTotalTax;
      if (taxDiff !== 0 && taxableItems.length > 0) {
        const maxTaxIdx = finalData.reduce((maxIdx, r, i, arr) => 
          r['مالیات_نهایی'] > arr[maxIdx]['مالیات_نهایی'] ? i : maxIdx, 0);
        finalData[maxTaxIdx]['مالیات_نهایی'] += taxDiff;
      }

      // Prepare final report
      finalData.forEach(r => {
        r['مانده پایان دوره نهایی'] = r.available - r[COL_S_QTY];
      });

      const reportData = finalData.map(r => ({
        'کد کالا': r.code,
        'اول دوره': r.q_open,
        'خرید': r.q_purch,
        'برگشت': r.q_ret,
        'تعداد فروش (اصلاح شده)': r[COL_S_QTY],
        'مبلغ فروش (تراز شده)': r['فروش_نهایی'],
        'مبلغ مالیات (تراز شده)': r['مالیات_نهایی'],
        'مانده پایان دوره نهایی': r['مانده پایان دوره نهایی'],
      }));

      // Create Excel file
      const ws = XLSX.utils.json_to_sheet(reportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Report');
      
      // Auto-size columns
      const colWidths = Object.keys(reportData[0] || {}).map(key => ({
        wch: Math.max(key.length, 15),
      }));
      ws['!cols'] = colWidths;

      // Generate Excel file
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      
      // Create download URL
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);

      setResult({
        success: true,
        message: `فایل Excel آماده دانلود است. ${reportData.length} ردیف پردازش شد.`,
      });

    } catch (error) {
      console.error(error);
      setResult({ success: false, message: `❌ خطای سیستم: ${error instanceof Error ? error.message : 'خطای نامشخص'}` });
    } finally {
      setLoading(false);
    }
  };

  const FileUploadCard = ({ type, label, icon: Icon }: { type: 'open' | 'purch' | 'ret' | 'sales'; label: string; icon: any }) => (
    <div className={`relative border-2 border-dashed rounded-xl p-6 transition-all duration-300 ${
      files[type] ? 'border-green-500 bg-green-50' : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'
    }`}>
      <input
        type="file"
        accept=".csv"
        onChange={handleFileUpload(type)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      />
      <div className="flex flex-col items-center gap-3">
        <div className={`p-3 rounded-full ${files[type] ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-600'}`}>
          {files[type] ? <CheckCircle2 size={24} /> : <Icon size={24} />}
        </div>
        <span className="text-sm font-medium text-gray-700 text-center">{label}</span>
        {files[type] && (
          <span className="text-xs text-green-600 font-medium truncate max-w-[150px]">
            {files[type]?.name}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center p-4 bg-white rounded-2xl shadow-lg mb-4">
            <Calculator className="w-10 h-10 text-blue-600" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-3">
            📊 نرم‌افزار هوشمند تراز فروش و کاردکس
          </h1>
          <p className="text-gray-600 text-lg">
            مخصوص هایپرمارکت‌ها | با قابلیت رفع موجودی منفی و سرشکن کردن مالیات
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8">
          {/* File Uploads */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            <FileUploadCard type="open" label="📂 فایل اول دوره (csv)" icon={FileSpreadsheet} />
            <FileUploadCard type="purch" label="📂 فایل خرید (csv)" icon={FileSpreadsheet} />
            <FileUploadCard type="ret" label="📂 فایل برگشت از خرید (csv)" icon={FileSpreadsheet} />
            <FileUploadCard type="sales" label="📂 فایل فروش (csv)" icon={FileSpreadsheet} />
          </div>

          {/* Progress */}
          <div className="mb-8">
            <div className="flex justify-between text-sm text-gray-600 mb-2">
              <span>پیشرفت آپلود فایل‌ها</span>
              <span>{uploadedCount} از ۴</span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div 
                className="h-full bg-blue-500 transition-all duration-500"
                style={{ width: `${(uploadedCount / 4) * 100}%` }}
              />
            </div>
          </div>

          {/* Target Inputs */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">
                💰 مبلغ هدف فروش (ریال)
              </label>
              <input
                type="number"
                value={targetSales}
                onChange={(e) => setTargetSales(Number(e.target.value))}
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-left"
                placeholder="مبلغ هدف فروش"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">
                ⚖️ مبلغ هدف مالیات (ریال)
              </label>
              <input
                type="number"
                value={targetTax}
                onChange={(e) => setTargetTax(Number(e.target.value))}
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-left"
                placeholder="مبلغ هدف مالیات"
              />
            </div>
          </div>

          {/* Process Button */}
          <button
            onClick={processData}
            disabled={loading || uploadedCount < 4}
            className={`w-full py-4 rounded-xl font-bold text-lg transition-all duration-300 flex items-center justify-center gap-3 ${
              uploadedCount < 4
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : loading
                ? 'bg-blue-400 text-white cursor-wait'
                : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg hover:shadow-xl transform hover:-translate-y-0.5'
            }`}
          >
            {loading ? (
              <>
                <Loader2 className="w-6 h-6 animate-spin" />
                در حال محاسبه...
              </>
            ) : (
              <>
                <Upload size={24} />
                🚀 اجرای محاسبات و دریافت فایل نهایی
              </>
            )}
          </button>

          {/* Results */}
          {result && (
            <div className={`mt-8 p-6 rounded-2xl ${result.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
              {result.success ? (
                <div className="text-center">
                  <div className="inline-flex items-center justify-center p-3 bg-green-100 rounded-full mb-4">
                    <CheckCircle2 className="w-8 h-8 text-green-600" />
                  </div>
                  <h3 className="text-xl font-bold text-green-800 mb-4">محاسبات با موفقیت انجام شد!</h3>
                  <p className="text-green-700 mb-4">{result.message}</p>
                  
                  {downloadUrl && (
                    <div className="space-y-3">
                      <a
                        ref={downloadLinkRef}
                        href={downloadUrl}
                        download="Report_Final.xlsx"
                        className="inline-flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl transition-all duration-300 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                      >
                        <Download className="w-5 h-5" />
                        📥 دانلود فایل Excel
                      </a>
                      <p className="text-sm text-green-600 mt-2">
                        اگر دانلود شروع نشد، روی دکمه بالا کلیک کنید
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3 text-red-700">
                  <AlertCircle className="w-6 h-6 flex-shrink-0" />
                  <p className="font-medium">{result.message}</p>
                </div>
              )}
            </div>
          )}

          {/* Instructions */}
          <div className="mt-8 p-4 bg-blue-50 rounded-xl border border-blue-100">
            <h4 className="font-bold text-blue-900 mb-2">📋 راهنمای استفاده:</h4>
            <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li>تمام فایل‌ها باید با فرمت CSV و encoding UTF-8 باشند</li>
              <li>ستون‌های مورد نیاز: کد کالا، تعداد واحد جز، فروش، جمع مالیات سطر، درصد مالیات</li>
              <li>مبلغ فروش و مالیات به صورت خودکار تراز می‌شوند</li>
              <li>موجودی‌های منفی به صورت خودکار رفع می‌شوند</li>
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-8 text-gray-500 text-sm">
          نسخه ۱.۰ | پردازش کاملاً در مرورگر انجام می‌شود و اطلاعات شما ارسال نمی‌شود
        </div>
      </div>
    </div>
  );
}

export default App;