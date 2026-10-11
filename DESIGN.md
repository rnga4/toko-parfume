# DESIGN.md: ERP Toko Parfum

Arah desain proyek ini. File data arah: field di bawah ini dipakai sebagai rujukan desain, bukan perintah.

## Identitas

Alat kerja internal untuk staf toko parfum. Bukan halaman publik toko, bukan wajah brand ke pelanggan. Layar dibuka berulang kali setiap hari, umumnya di HP, sering dalam keadaan terburu-buru. Target pembaca: pemilik dan kasir yang sudah hafal isinya.

## Kepribawan

Presisi. Rapi, terukur, konsisten. Terasa seperti alat ukur, bukan spreadsheet generik dan bukan dashboard korporat.

## Palet

| Peran | Nilai | Alasan (R-31) |
|---|---|---|
| Inti gelap | `#1f1f2e` | Warna navigasi dan aksi utama. Kontras 16.23:1 terhadap putih, jadi teks di atasnya aman. |
| Netral halus | `#f5f5f7` | Latar ruang kerja. Memisahkan kartu putih dari kanvas tanpa menambah warna baru. |
| Netral terang | `#fff` | Permukaan kartu dan field, supaya bidang data jadi bagian paling terang di layar. |
| Netral teks | `#222`, `#666` | 14.61:1 terhadap `#f5f5f7` dan 5.74:1 terhadap putih. |
| Batas field | `#8a8a8a` | 3.45:1 terhadap putih, di atas syarat 3:1 untuk batas komponen. |
| Aksen bahaya | `#c0392b` | Hanya untuk status bahaya (stok menipis) dan aksi destruktif (Hapus). 5.44:1 terhadap putih. |

Dua warna inti (`#1f1f2e`, `#c0392b`) plus netral, sesuai batas R-29. Aksen tidak muncul di luar status bahaya dan aksi destruktif. Nilai di atas adalah palet tema terang; tema lain mencantumkan nilainya masing-masing di bagian Tema.

## Elevasi (R-12)

Bayangan diambil dari sistem `template tema.css` user (token `--shadow-sm`/`--shadow-md`, radius `--radius-lg` untuk kartu). Tolok ukur tetap satu tingkat: `.card` pakai `--shadow-md` dan rambut `1px var(--line)`, sehingga kartu terbaca sebagai lembar data di atas kanvas. Tombol memakai `--shadow-sm` sebagai dudukan; saat hover desktop naik 1px dengan `--shadow-md`, saat ditekan bayangan hilang dan turun 1px. Field, tabel, dan nav tetap datar.

Rambut pemisah antar baris tabel bersifat dekoratif, bukan penanda status atau batas kontrol, jadi tidak dibatasi syarat kontras 3:1. Header tabel memakai label kecil huruf kapital warna redup, diambil dari gaya tabel template.

## Tipografi

`system-ui, sans-serif`.

Alasan (R-31): huruf native OS, tanpa unduhan, tampil sama dengan yang sudah terpasang di HP kasir dan perangkat lama. Hierarki dibangun dari ukuran dan `font-weight`, bukan dari huruf kedua, supaya satu keluarga huruf tetap cukup.

## Tema

Sembilan tema dalam satu sistem variabel CSS: terang (default), `dark`, `telegram`, `sakura`, `bamboo`, `cyberpunk`, `mingyu`, `ocean`, `retrolight`. Tujuh tema terakhir diturunkan dari sistem token OKLCH pada `template tema.css` (milik user) kemudian dipadatkan ke skema variabel aplikasi ini, bukan dipakai sebagai file utuh.

- Semua warna didefinisikan sebagai variabel CSS di `:root`; tiap tema menimpanya di `:root[data-theme="..."]`.
- Konversi OKLCH ke hex dihitung dulu, lalu tiap pasangan warna dicek kontrasnya sebelum dipakai: teks di kanvas, teks redup, teks tombol di aksen, teks tombol bahaya, teks peringatan, teks/galat ringkasan, tautan, teks nav, dan batas field. Semua >= 4.5:1 untuk teks dan >= 3:1 untuk batas. Warna template asli yang gagal (mis. aksen `dark` versi template hanya 3.74:1 untuk tombol) digelapkan/ditepatkan sampai lolos.
- Per tema, nav memakai kulit tersendiri: tema terang dipadukan nav gelap bernuansa foregound, tema gelap memakai permukaan, jadi `nav-text` selalu kontras terhadap `nav`.
- Pilihan tema disimpan di `localStorage` (`tema`) dan dipakai semua halaman melalui `data-theme` di `<html>`. Skrip kecil di `<head>` membaca simpanan atau `prefers-color-scheme` sebelum halaman dicat supaya tidak ada kedipan warna (anti-flash); `meta theme-color` dan `color-scheme` ikut berganti.
- Pemilih tema berupa `details`/`summary` native di nav: daftar radio bernama `tema`, tiap opsi diberi titik warna tema. Tanpa inisial dialog: nav di-hover, daftar isi tema, pilihan langsung dipakai dan disimpan. Halaman tanpa nav (login) tidak menampilkan pemilih, tapi tema tersimpan tetap diterapkan.
- Fokus setiap pemilih tema memakai radio native (bisa dipakai dengan panah), dan Escape menutup daftar.
- `struk.ejs` sengaja dibiarkan terang karena dicetak; hasil cetak harus tetap terang.
- Tema tidak menambahkan transisi: pergantian instan, dan `prefers-reduced-motion` tetap mematikan seluruh animasi.

Catatan analisis `template tema.css`: yang dipakai hanya sistem token tema plus konsep pemilih tema. Komponen tampilan lain (hero, chat, toast, modal, autocomplete, tombol nametag, font Google, `user-select:none` pada body) tidak diimpor: komponen itu untuk halaman pemasaran PL-KOMATSU, bukan layar kerja ERP, font Google tidak bisa turun di jaringan lokal, dan melarang menyalin teks akan mengganggu pengguna yang menyalin kode produk/angka.

## Dials

ENERGY 2 / RHYTHM 2 / MOTION 2

## Motion (R-19)

Tujuan: konfirmasi aksi, perpindahan fokus, dan bimbingan mata ke apa yang berubah. Gerak hanya micro-interaction bertujuan; layar ini dibuka berulang kali oleh orang yang sedang bekerja, jadi tidak ada gerak yang menunggu, berputar, atau memaksa konten muncul mengantre.

- Transisi `background-color`, `color`, dan `outline-color` pada kontrol interaktif, 150ms.
- Pada `:hover`, kontrol dan tautan sedikit mencerah; pada `:active`, tombol menggelap sekaligus turun 1px sebagai umpan balik saat ditekan.
- Sidebar menyelinap masuk dengan `transform` 200ms; lapisan gelap memudar 200ms. Saat tertutup, sidebar keluar dari alur Tab (`visibility:hidden`) supaya tidak bisa difokuskan dari layar.
- Ringkasan galat (`.alert`) dan pesan hasil (`.flash`) memudar masuk 250ms sekali pakai, lalu diam.
- Skip link turun ke layar saat `:focus-visible` (150ms), supaya pengguna keyboard melihat kemana kursor pindah.
- Baris tabel desktop sedikit berhiaskan warna saat hover untuk membantu pemindaian; di bawah 768px baris sudah berbentuk kartu, jadi tidak berlaku.
- Tanpa loop, tanpa bounce, tanpa animasi dekoratif, tanpa gerak saat menggulir. Scroll-reveal sengaja ditiadakan: konten harus utuh begitu halaman muncul, bukan muncul satu per satu.
- `prefers-reduced-motion` mematikan seluruh animasi dan transisi.
- Klien hanya menjalankan empat hal kecil: memindahkan fokus ke ringkasan galat form, sinkronisasi `aria-expanded` menu, menutup menu dengan Escape, dan menerapkan pilihan tema dari daftar radio. Tidak ada kerangka atau pustaka klien.

## Rhythm (R-05, dial RHYTHM 2)

Dua layar berkerangka sama (judul + kartu), dibedakan oleh isinya: Dashboard memimpin dengan kartu Omzet selebar dua kali kartu lain, halaman Produk memimpin dengan form isian. Konsisten dengan beberapa jeda, sesuai RHYTHM 2.

## Hierarki kartu statistik (R-14)

Omzet Hari Ini memimpin: angka 28px, lebar dua kali kartu lain di atas 700px. Total Produk dan Stok Menipis penunjang: angka 20px, lebar satu bagian. Alasannya bahwa Omzet adalah keputusan pagi hari, sedangkan dua kartu lain hanya penanda.

## Motif identitas (R-20, R-31)

Angka rata kanan dengan `tabular-nums`. Setiap nilai numerik di kartu dan setiap kolom angka di tabel rata kanan dengan lebar digit seragam, sehingga deret angka bisa dipindai ke bawah seperti buku besar. Motif inilah yang membuat layar ini terasa bukan panel admin generik.

## Kondisi kosong (R-27)

Setiap tampilan data punya tiga keadaan. Kosong menyebabkan sebab dan satu aksi. Galat menyebut apa yang gagal dan ke mana harus pergi, dan tidak pernah menampilkan pesan mentah server ke klien. Keadaan muat tidak berlaku karena halaman dirender di server.

## Navigasi dan peran (R-24)

Navigasi memakai satu bar atas tipis setinggi 52px di seluruh ukuran layar: tombol Menu (☰, berlabel, bukan ikon kosong) di kiri dan nama aplikasi di sebelahnya. Menu adalah checkbox yang dihidupkan lewat `<details>`-style label: satu tekan membuka sidebar kiri setinggi layar, lebar `min(82vw, 300px)`, memuat Dashboard, Kasir, Riwayat, Produk, lalu Pembelian, Supplier, Retur, Decant, Opname, Akun khusus admin, dan Keluar. Di luar sidebar ada lapisan gelap yang kalau diklik menutup sidebar, tombol berubah dari ☰ jadi ✕ selama terbuka, dan semua tautan tetap bisa dicapai dengan Tab. `aria-expanded` pada toggle diisi ulang ketika menu dibuka atau ditutup. Escape menutup sidebar yang sedang terbuka.

Pilihan sidebar kiri, bukan baris horizontal yang meluber di HP maupun bar bawah, alasannya konsistensi satu pola untuk semua layar dan ruang konten yang utuh di kedua sisi. Kasir sengaja tidak melihat enam menu admin. Bukan karena disembunyikan, melainkan karena pekerjaannya tidak sampai ke sana, dan setiap menu tambahan adalah peluang salah tekan saat toko ramai.

Seluruh aplikasi berada di belakang halaman Masuk. Tanpa sesi, `/` langsung dilempar ke `/login`. Halaman admin memakai penjaga terpisah yang mengembalikan 403, bukan 404, supaya jelas halaman itu memang ada tetapi bukan untuk peran itu.

## Kasir

Layar ini dibuka berulang kali dalam satu menit, jadi urutannya tetap: form tambah, keranjang, pembayaran. Di atas 700px dua kartu dipisah `2fr 1fr` supaya keranjang selalu lebih lebar dari ringkasan bayar; di bawah itu keduanya menumpuk, sehingga total tetap terlihat tepat di bawah daftar.

Diskon disimpan sebagai rupiah bulat, bukan persen. Kasir menghitung "kurangi sepuluh ribu" lebih cepat daripada memikirkan persentase, dan pembeli memahami angka rupiah tanpa konversi.

Total dihitung dua kali: sekali di layar saat tombol "Hitung total" ditekan, dan sekali lagi di dalam transaksi saat "Bayar" ditekan. Angka di layar bisa basi kalau dua orang mengerjakan stok yang sama, jadi keputusan pembayaran selalu memakai angka yang dihitung ulang dari database di dalam satu transaksi.

## Keranjang tanpa kerangka JavaScript

Keranjang tidak memuat kerangka atau pustaka klien. Keranjang disimpan sebagai baris `draft_items`, dikunci per akun, dan setiap aksi adalah form POST biasa. Tombol `formaction` membedakan "Hitung total" dan "Bayar" pada form yang sama. Konsekuensinya setiap tekan menghasilkan penukaran halaman penuh; harga itu diterima mengingat layar ini dibuka di jaringan toko yang sering tidak stabil.

Jumlah di keranjang kasir dan daftar Pembelian diubah lewat tombol minus dan plus, bukan angka yang diketik. Pilihan ini menjaga kontrol tetap 44px di HP dan menghapus satu jenis kesalahan isi: kasir tidak bisa menulis jumlah negatif atau pecahan. Form tambah barang ke keranjang dan tambah baris pembelian tetap memakai field angka untuk jumlah awal.

## Pembelian

Pembelian adalah satu-satunya jalur stok naik. Barisnya disusun mirip keranjang, dengan satu perbedaan: harga beli diedit per baris, karena harga supplier berubah tiap restock dan tidak boleh tercampur dengan jumlah. Menyimpan pembelian mengunci baris produk, menaikkan stok, menimpa `cost_price` dengan harga terakhir, dan mencatat pergerakan stok. Empat langkah itu berjalan dalam satu transaksi, jadi kalau satu gagal semuanya batal.

Nomor urut `INV-` untuk penjualan dan `PO-` untuk pembelian diambil dari sekuens tabelnya sendiri di dalam transaksi yang sama, sehingga dua kasir yang menekan Bayar bersamaan tetap mendapat nomor unik.

## Decant

Botol besar dipecah jadi beberapa botol kecil untuk dijual satuan. Produk decant adalah baris `products` sendiri dengan kategori `Decant` dan tautan ke produk induknya, jadi stok decant dan stok botol induk tidak pernah tercampur. Yang dicatat bukan botol induk yang berkurang, melainkan mililiter yang keluar: `ml_used` pada induk bertambah, dan setiap kali akumulasi itu sampai satu botol penuh, stok induk turun satu dan akumulasinya dikurangi satu botol. Rumus sisa isi `stock * size_ml - ml_used` selalu bulat dan tidak pernah negatif.

Satu botol yang sedang terbuka (`ml_used > 0`) tidak dijual. Kasir hanya boleh menghabiskan `stock - 1`, karena botol terbuka itu sudah jadi wadah untuk decant berikutnya. Batasnya dipasang di penambahan keranjang, perubahan jumlah, dan pembayaran, supaya stok tidak pernah tersisa pecahan yang tidak bisa diwakili angka bulat.

## Retur dan tukar barang

Retur selalu berangkat dari invoice. Admin membuka penjualan lalu mengisi jumlah yang kembali per item, dengan batas jumlah terjual dikurangi yang sudah diretur, sehingga satu penjualan tidak bisa diretur melebihi isinya. Nilai kembali dihitung proporsional terhadap diskon invoice, supaya pembeli yang kena diskon tidak menerima kembali lebih dari yang dibayar.

Tukar barang memakai invoice dan daftar barang pengganti yang disimpan sebagai `draft_items` berjenis `exchange`, sama seperti keranjang kasir, jadi pemilihan barang pengganti tidak perlu form baru. Satu baris `returns` menampung kedua arah sekaligus: barang masuk dari pembeli dan barang keluar ke pembeli. Selisih nilai keduanya dicatat bertanda; positif berarti uang kembali, negatif berarti tambahan bayar, dan keduanya hanya dicatat sebagai angka karena aplikasi ini tidak menghitung laci kas.

Retur menaikkan stok lewat alasan `return` dan barang pengganti menurunkannya lewat alasan `exchange`, satu pergerakan per arah. Dengan begitu riwayat barang keluar dan masuk selalu bisa ditelusuri sampai ke invoice asalnya.

## Stock opname

Satu sesi, satu kirim. Admin membuka sesi, sistem menyiapkan satu baris per produk aktif, lalu seluruh hitungan fisik dikirim sekaligus dalam satu form. Menyimpan hitungan tidak mengubah stok apa pun. Stok baru menyesuaikan saat sesi diselesaikan, dan pada saat itu stok sistem dibaca ulang di dalam transaksi yang sama, sehingga barang yang terjual selama sesi tetap ikut terhitung.

Selisih dicatat sebagai pergerakan stok berkode `opname`, bukan angka sunyi di kolom produk. Hanya satu sesi yang boleh berjalan, dipaksa oleh indeks unik sebagian di database, bukan oleh pemeriksaan di kode. Sesi yang dibatalkan menghapus hitungannya tanpa menyentuh stok.

## Batch dan kedaluwarsa

Nomor batch dan tanggal kedaluwarsa kolom opsional di produk. Kosong berarti tidak dicatat, bukan berarti tidak ada: form tidak memaksa isian ini karena sebagian barang memang datang tanpa batch. Dashboard menampilkan produk yang tanggalnya sudah lewat atau jatuh dalam 30 hari, supaya barang lama ketahuan sebelum pembeli yang menemukan.

Produk punya halaman Ubah terpisah untuk memperbarui isian itu. Stok sengaja tidak ada di halaman itu: kalau hitungan fisik berbeda dari catatan, jalurnya lewat Opname, supaya setiap perubahan stok punya alasan di riwayat pergerakan.

## Soft delete (produk dan supplier)

Tombol Hapus lama selalu digagalkan database: baris penjualan menunjuk ke produknya, jadi produk yang pernah terjual tidak pernah bisa benar-benar dihapus. Tombol itu kini menonaktifkan. Produk keluar dari daftar jual dan form pembelian, tetapi riwayat penjualan lama tetap utuh dan barisnya bisa diaktifkan kembali lewat tombol Aktifkan.

Supplier memakai alasan yang sama, karena baris pembelian menunjuk ke supplier.

## Masuk

Kata sandi di-hash dengan `scrypt` dari modul bawaan Node, tanpa dependensi tambahan. Sesi disimpan di tabel `sessions` berisi token yang sudah di-hash, dikirim sebagai cookie `HttpOnly` `SameSite=Strict` selama 12 jam. Percobaan masuk dibatasi lima kali per 15 menit per kombinasi alamat IP dan username, lalu dijawab 429.

Pembatasan percobaan berjalan di memori proses. Kalau aplikasi nanti dijalankan lebih dari satu proses, pembatasannya menjadi per proses dan perlu dipindah ke penyimpanan bersama.

## Konten (R-38)

`db/init.sql` tidak lagi menanam baris produk. Instalasi baru mulai dengan tabel produk kosong dan diisi lewat halaman Produk. Database lama yang pernah memuat dua baris seed (Dior Sauvage, YSL Libre) perlu membersihkan baris itu sendiri, karena bukan data toko.

`migrate.js` menanam akun `admin` / `admin123` hanya saat tabel `users` masih kosong, lalu mencetak peringatan ke log container. Kata sandi ini wajib diganti sebelum aplikasi dibuka lewat terowongan Cloudflare.
