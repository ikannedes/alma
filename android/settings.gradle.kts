pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "alma"
// protocolo: reglas de mudanza y órdenes de voz (Kotlin puro, con pruebas en la JVM)
// nucleo: el núcleo de Alma en C por el NDK; reloj: app de Wear OS; celular: APK del teléfono
include(":protocolo", ":nucleo", ":reloj", ":celular", ":caratula")
